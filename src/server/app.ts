import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { constants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import path from 'node:path';
import { z, ZodError } from 'zod';
import { exportRequestSchema } from '../shared/export.js';
import { MAX_FOOTAGE_FILES } from '../shared/footage.js';
import type { SourceFingerprint } from '../shared/media.js';
import { frameSchema, idSchema, projectSchema } from '../shared/model.js';
import { validateSourceRanges } from '../shared/source-range.js';
import { AudioLibrary } from './audio.js';
import { createConfig, type ServiceConfig } from './config.js';
import { errorMessage, isNotFound, ServiceError } from './errors.js';
import { restoreExports } from './export-archive.js';
import { startExport } from './export.js';
import { assertNoSymlinks, assertSourceIdentity, parseByteRange } from './files.js';
import { FootageBrowser } from './footage.js';
import { JobQueue } from './jobs.js';
import { MediaLibrary, MediaQueueError } from './library.js';
import { startReference } from './reference.js';
import { ensurePrivateDirectory, ProjectStore } from './storage.js';

const idParams = z.object({ id: idSchema });
const importSchema = z.object({ directory: z.string().min(1).max(4096) }).strict();
const registerSchema = z.object({ path: z.string().min(1).max(4096) }).strict();
const footageQuerySchema = z.object({ rootId: z.string().min(1).max(128), directory: z.string().min(1).max(4096).optional() }).strict();
const registerPathsSchema = z.object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(MAX_FOOTAGE_FILES) }).strict();
const saveSchema = z.object({ document: projectSchema, expectedRevision: frameSchema }).strict();
const referenceSchema = z.object({ document: projectSchema }).strict();
const titleSchema = z.string().trim().min(1).max(200);
const createProjectSchema = z.object({ title: titleSchema }).strict();
const renameProjectSchema = z.object({ title: titleSchema, expectedRevision: frameSchema }).strict();
const deleteProjectSchema = z.object({ expectedRevision: frameSchema.nullable() }).strict();

function validateLocalRequest(request: FastifyRequest, reply: FastifyReply, config: ServiceConfig): void {
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (!host || !config.allowedHosts.has(host) || (origin && !config.allowedOrigins.has(origin)) || request.headers['sec-fetch-site'] === 'cross-site') {
    throw new ServiceError('Only trusted loopback Host and Origin values are accepted.', 403);
  }
  if (!['GET', 'HEAD'].includes(request.method) && request.headers['x-pascap-client'] !== 'preview-lab') throw new ServiceError('Local JSON requests must identify the PasCap client.', 403);
  reply.header('X-Content-Type-Options', 'nosniff').header('Cross-Origin-Resource-Policy', 'same-origin');
}

export async function serveRegisteredFile(request: FastifyRequest, reply: FastifyReply, filename: string, mime: string): Promise<void> {
  const checked = await assertNoSymlinks(filename).catch((error: unknown) => {
    if (isNotFound(error)) throw new ServiceError('Registered output file not found.', 404);
    throw error;
  });
  if (!checked.isFile()) throw new ServiceError('Only registered regular files can be served.', 422);
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ServiceError('Only registered regular files can be served.', 422);
    reply.type(mime).header('Accept-Ranges', 'bytes').header('Cache-Control', 'private, no-cache');
    const header = request.headers.range;
    if (header) {
      const range = parseByteRange(header, info.size);
      if (!range) { await reply.code(416).header('Content-Range', `bytes */${info.size}`).send(); return; }
      reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`).header('Content-Length', range.end - range.start + 1);
      if (request.method === 'HEAD') { await reply.send(); return; }
      await reply.send(file.createReadStream(range)); return;
    }
    reply.header('Content-Length', info.size);
    if (request.method === 'HEAD') { await reply.send(); return; }
    await reply.send(file.createReadStream());
  } finally { await file.close(); }
}

export async function createApp(config = createConfig()) {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, requestTimeout: 120_000 });
  const jobs = new JobQueue();
  const library = new MediaLibrary(config, jobs);
  const footage = new FootageBrowser(config);
  const audio = new AudioLibrary(config, jobs);
  const projects = new ProjectStore(config.dataDir);
  await ensurePrivateDirectory(config.dataDir);
  await library.initialise();
  await audio.initialise();
  const archiveWarnings = await restoreExports(config, jobs);
  archiveWarnings.forEach((message) => app.log.warn({ message }, 'Skipped invalid export receipt'));
  app.addHook('onRequest', async (request, reply) => validateLocalRequest(request, reply, config));
  app.addHook('onClose', async () => jobs.close());
  app.setErrorHandler(async (error, _request, reply) => {
    let status = 500;
    if (error instanceof ServiceError) status = error.statusCode;
    if (error instanceof ZodError) status = 400;
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('FST_ERR_CTP_') &&
        'statusCode' in error && typeof error.statusCode === 'number' && [400, 413, 415].includes(error.statusCode)) status = error.statusCode;
    const message = error instanceof ZodError ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : errorMessage(error);
    const body = error instanceof MediaQueueError ? { error: message, mediaId: error.asset.id, asset: error.asset, job: null } : { error: message };
    await reply.code(status).send(body);
  });
  app.get('/api/health', (_request, reply) => reply.send({ name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 }));
  app.get('/api/media', (_request, reply) => reply.send({ assets: library.list() }));
  app.get('/api/footage/roots', async () => ({ roots: await footage.roots() }));
  app.get('/api/footage', async (request) => {
    const query = footageQuerySchema.parse(request.query);
    return footage.browse(query.rootId, query.directory);
  });
  app.post('/api/media/register-paths', async (request, reply) => {
    const paths = footage.validatePaths(registerPathsSchema.parse(request.body).paths);
    return reply.code(202).send(await library.addFilesForEditing(paths));
  });
  app.post('/api/media/import', async (request, reply) => reply.code(202).send(await library.importForEditing(footage.validateManualPath(importSchema.parse(request.body).directory))));
  app.post('/api/media/register', async (request, reply) => reply.code(202).send(await library.addForEditing(footage.validateManualPath(registerSchema.parse(request.body).path))));
  app.post('/api/media/:id/prepare', async (request) => {
    z.object({}).strict().parse(request.body);
    return { job: await library.prepare(idParams.parse(request.params).id) };
  });
  app.route({
    method: ['GET', 'HEAD'], url: '/api/media/:id/proxy', handler: async (request, reply) => {
      const asset = library.get(idParams.parse(request.params).id);
      await assertSourceIdentity(asset.sourcePath, asset.fingerprint);
      if (asset.status !== 'ready' || !asset.prepared) throw new ServiceError('The proxy is not verified and ready.', 409);
      await serveRegisteredFile(request, reply, library.proxyPath(asset), 'video/mp4');
    }
  });
  app.route({
    method: ['GET', 'HEAD'], url: '/api/media/:id/source', handler: async (request, reply) => {
      const asset = library.get(idParams.parse(request.params).id);
      await assertSourceIdentity(asset.sourcePath, asset.fingerprint);
      await serveRegisteredFile(request, reply, asset.sourcePath, 'video/mp4');
    }
  });
  app.get('/api/media/:id/thumbnail/:frame', async (request, reply) => {
    const parameters = z.object({ id: idSchema, frame: z.coerce.number().int().nonnegative() }).parse(request.params);
    const asset = library.get(parameters.id);
    await assertSourceIdentity(asset.sourcePath, asset.fingerprint);
    if (!asset.prepared?.thumbnailFrames.includes(parameters.frame)) throw new ServiceError('Indexed thumbnail not found.', 404);
    await serveRegisteredFile(request, reply, library.thumbnailPath(asset, parameters.frame), 'image/jpeg');
  });
  app.get('/api/audio', (_request, reply) => reply.send({ assets: audio.list() }));
  app.post('/api/audio/register', async (request, reply) => reply.code(202).send(await audio.register(registerSchema.parse(request.body).path)));
  app.post('/api/audio/:id/prepare', async (request, reply) => {
    z.object({}).strict().parse(request.body);
    return reply.code(202).send({ job: await audio.prepare(idParams.parse(request.params).id) });
  });
  app.route({
    method: ['GET', 'HEAD'], url: '/api/audio/:id/playback', handler: async (request, reply) => {
      const asset = await audio.assertReady(idParams.parse(request.params).id);
      await serveRegisteredFile(request, reply, audio.playbackPath(asset), 'audio/mp4');
    }
  });
  app.get('/api/audio/:id/waveform', async (request) => ({ waveform: (await audio.assertReady(idParams.parse(request.params).id)).waveform }));
  app.get('/api/projects', async () => ({ projects: await projects.list() }));
  app.post('/api/projects', async (request, reply) => reply.code(201).send({ document: await projects.create(createProjectSchema.parse(request.body).title) }));
  app.get('/api/projects/:id', async (request) => ({ document: await projects.load(idParams.parse(request.params).id) }));
  app.post('/api/projects/:id/rename', async (request) => {
    const body = renameProjectSchema.parse(request.body);
    return { document: await projects.rename(idParams.parse(request.params).id, body.title, body.expectedRevision) };
  });
  app.delete('/api/projects/:id', async (request) => {
    const body = deleteProjectSchema.parse(request.body);
    await projects.delete(idParams.parse(request.params).id, body.expectedRevision);
    return { deleted: true };
  });
  app.put('/api/projects/:id', async (request) => {
    const body = saveSchema.parse(request.body);
    if (body.document.id !== idParams.parse(request.params).id) throw new ServiceError('Project ID must match its route.');
    body.document.media.videoIds.forEach((id) => library.get(id));
    body.document.media.audioIds.forEach((id) => audio.get(id));
    const sources = new Map<string, { sourcePath: string; fingerprint: SourceFingerprint }>();
    const frameCounts = new Map(body.document.clips.map((clip) => { const asset = library.get(clip.mediaId); return [asset.id, asset.metadata.frameCount] as const; }));
    try { validateSourceRanges(body.document, frameCounts); }
    catch (error) { throw new ServiceError(errorMessage(error), 422); }
    for (const clip of body.document.clips) {
      const asset = library.get(clip.mediaId);
      if (clip.sourceOut > asset.metadata.frameCount) throw new ServiceError(`Clip ${clip.id} exceeds its registered source frames.`, 422);
      sources.set(`video:${asset.id}`, asset);
    }
    if (body.document.music !== null) {
      const asset = audio.get(body.document.music.mediaId);
      if (body.document.music.sourceOut > asset.metadata.frameCount) throw new ServiceError('Music exceeds its registered source frames.', 422);
      sources.set(`audio:${asset.id}`, asset);
    }
    await [...sources.values()].reduce(async (previous, asset) => {
      await previous;
      await assertSourceIdentity(asset.sourcePath, asset.fingerprint, true);
    }, Promise.resolve());
    return { document: await projects.save(body.document, body.expectedRevision) };
  });
  app.get('/api/jobs', (_request, reply) => reply.send({ jobs: jobs.list() }));
  app.get('/api/jobs/:id', (request, reply) => reply.send({ job: jobs.get(idParams.parse(request.params).id) }));
  app.post('/api/jobs/:id/cancel', (request, reply) => {
    z.object({}).strict().parse(request.body);
    jobs.cancel(idParams.parse(request.params).id); return reply.send({ job: jobs.get(idParams.parse(request.params).id) });
  });
  app.post('/api/reference', (request, reply) => reply.send({ job: startReference(referenceSchema.parse(request.body).document, library) }));
  app.post('/api/exports', (request, reply) => {
    const body = exportRequestSchema.parse(request.body);
    return reply.code(202).send({ job: startExport(body.document, body.profile, library, (id) => audio.get(id)) });
  });
  for (const type of ['reference', 'export', 'receipt'] as const) {
    app.route({
      method: ['GET', 'HEAD'], url: `/api/jobs/:id/${type}`, handler: async (request, reply) => {
        const id = idParams.parse(request.params).id;
        if (jobs.get(id).state !== 'completed') throw new ServiceError('Reference output is not complete.', 409);
        const filename = type === 'receipt' ? 'receipt.json' : `${type}.mp4`;
        if (type !== 'receipt' && jobs.get(id).kind !== type) throw new ServiceError('This job has no requested output.', 404);
        await serveRegisteredFile(request, reply, path.join(config.dataDir, 'renders', id, filename), type === 'receipt' ? 'application/json' : 'video/mp4');
      }
    });
  }
  try {
    await access(path.join(config.webDir, 'index.html'));
    await app.register(fastifyStatic, { root: config.webDir, wildcard: false, index: ['index.html'], dotfiles: 'deny' });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    app.get('/', (_request, reply) => reply.send({ name: 'PasCap', message: 'Use the Vite development page, or build the frontend first.' }));
  }
  return { app, library, audio, jobs, projects, config };
}