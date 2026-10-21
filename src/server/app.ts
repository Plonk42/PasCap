import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { constants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import path from 'node:path';
import { z, ZodError } from 'zod';
import { exportRequestSchema } from '../shared/export.js';
import { MAX_FOOTAGE_FILES } from '../shared/footage.js';
import { frameSchema, idSchema, projectSchema } from '../shared/model.js';
import { AudioLibrary } from './audio.js';
import { BrowsePreviews } from './browse-previews.js';
import { createConfig, type ServiceConfig } from './config.js';
import { errorMessage, isNotFound, ServiceError } from './errors.js';
import { restoreExports } from './export-archive.js';
import { requireExportReserve } from './export-space.js';
import { preflightExport, startExport } from './export.js';
import { assertNoSymlinks, assertSourceIdentity, parseByteRange } from './files.js';
import { FootageBrowser } from './footage.js';
import { JobQueue } from './jobs.js';
import { registerOperations } from './operations/index.js';
import { assertProjectSources } from './project-sources.js';
import { submitFolderRelink } from './relink.js';
import { MediaLibrary, MediaQueueError } from './library.js';
import { startReference } from './reference.js';
import { ensurePrivateDirectory, ProjectStore } from './storage.js';

const idParams = z.object({ id: idSchema });
const importSchema = z.object({ directory: z.string().min(1).max(4096) }).strict();
const registerSchema = z.object({ path: z.string().min(1).max(4096) }).strict();
const footageQuerySchema = z
  .object({ rootId: z.string().min(1).max(128), directory: z.string().min(1).max(4096).optional() })
  .strict();
const previewQuerySchema = z.object({ path: z.string().min(1).max(4096) }).strict();
const registerPathsSchema = z
  .object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(MAX_FOOTAGE_FILES) })
  .strict();
const saveSchema = z.object({ document: projectSchema, expectedRevision: frameSchema }).strict();
const referenceSchema = z.object({ document: projectSchema }).strict();
const titleSchema = z.string().trim().min(1).max(200);
const createProjectSchema = z.object({ title: titleSchema }).strict();
const renameProjectSchema = z.object({ title: titleSchema, expectedRevision: frameSchema }).strict();
const deleteProjectSchema = z.object({ expectedRevision: frameSchema.nullable() }).strict();
const importProjectSchema = z.object({ document: z.unknown() }).strict();

function validateLocalRequest(request: FastifyRequest, reply: FastifyReply, config: ServiceConfig): void {
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (
    !host ||
    !config.allowedHosts.has(host) ||
    (origin && !config.allowedOrigins.has(origin)) ||
    request.headers['sec-fetch-site'] === 'cross-site'
  ) {
    throw new ServiceError('Only trusted loopback Host and Origin values are accepted.', 403);
  }
  if (!['GET', 'HEAD'].includes(request.method) && request.headers['x-pascap-client'] !== 'preview-lab')
    throw new ServiceError('Local JSON requests must identify the PasCap client.', 403);
  reply.header('X-Content-Type-Options', 'nosniff').header('Cross-Origin-Resource-Policy', 'same-origin');
}

function exportFilename(label: string): string {
  const base = label.replace(/\.mp4$/i, '').replaceAll(/[\p{Cc}/\\]/gu, '_');
  return `${base || 'export'}.mp4`;
}

/** Inline stays playable in the browser; the name only drives Save as / download. */
function contentDisposition(name: string): string {
  const ascii = name.replaceAll(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replaceAll(
    /['()*]/g,
    (char) => `%${char.codePointAt(0)!.toString(16).toUpperCase()}`,
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function serveRegisteredFile(
  request: FastifyRequest,
  reply: FastifyReply,
  filename: string,
  mime: string,
  downloadName?: string,
): Promise<void> {
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
    if (downloadName) reply.header('Content-Disposition', contentDisposition(downloadName));
    const header = request.headers.range;
    if (header) {
      const range = parseByteRange(header, info.size);
      if (!range) {
        await reply.code(416).header('Content-Range', `bytes */${info.size}`).send();
        return;
      }
      reply
        .code(206)
        .header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
        .header('Content-Length', range.end - range.start + 1);
      if (request.method === 'HEAD') {
        await reply.send();
        return;
      }
      await reply.send(file.createReadStream(range));
      return;
    }
    reply.header('Content-Length', info.size);
    if (request.method === 'HEAD') {
      await reply.send();
      return;
    }
    await reply.send(file.createReadStream());
  } finally {
    await file.close();
  }
}

export async function createApp(config = createConfig()) {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, requestTimeout: 120_000 });
  const jobs = new JobQueue();
  const library = new MediaLibrary(config, jobs);
  const footage = new FootageBrowser(config);
  const previews = new BrowsePreviews(config);
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
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code.startsWith('FST_ERR_CTP_') &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      [400, 413, 415].includes(error.statusCode)
    )
      status = error.statusCode;
    const message =
      error instanceof ZodError
        ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
        : errorMessage(error);
    const body =
      error instanceof MediaQueueError
        ? { error: message, mediaId: error.asset.id, asset: error.asset, job: null }
        : { error: message };
    await reply.code(status).send(body);
  });
  app.get('/api/health', (_request, reply) =>
    reply.send({ name: 'PasCap', milestone: 'editing-and-export', frameRate: '30000/1001', workerConcurrency: 1 }),
  );
  app.get('/api/media', async (_request, reply) =>
    reply.send({ assets: library.list(), missing: await library.missing() }),
  );
  app.get('/api/footage/roots', async () => ({ roots: await footage.roots() }));
  app.get('/api/footage', async (request) => {
    const query = footageQuerySchema.parse(request.query);
    return footage.browse(query.rootId, query.directory);
  });
  app.get('/api/footage/preview', async (request, reply) => {
    const filename = footage.validateVideoPath(previewQuerySchema.parse(request.query).path);
    reply.header('Cache-Control', 'private, no-cache');
    const tag = `"${await previews.tag(filename)}"`;
    if (request.headers['if-none-match'] === tag) return reply.code(304).header('ETag', tag).send();
    // A closed tab or navigation away cancels the read.
    const controller = new AbortController();
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    const preview = await previews.get(filename, controller.signal);
    return reply.type('image/jpeg').header('ETag', `"${preview.tag}"`).send(preview.image);
  });
  app.post('/api/media/register-paths', async (request, reply) => {
    const paths = footage.validatePaths(registerPathsSchema.parse(request.body).paths);
    return reply.code(202).send(await library.addFilesForEditing(paths));
  });
  app.post('/api/media/import', async (request, reply) =>
    reply
      .code(202)
      .send(await library.importForEditing(footage.validateManualPath(importSchema.parse(request.body).directory))),
  );
  app.post('/api/media/register', async (request, reply) =>
    reply
      .code(202)
      .send(await library.addForEditing(footage.validateManualPath(registerSchema.parse(request.body).path))),
  );
  app.post('/api/media/:id/prepare', async (request) => {
    const { blackOutDamage } = z.object({ blackOutDamage: z.boolean().optional() }).strict().parse(request.body);
    return { job: await library.prepare(idParams.parse(request.params).id, blackOutDamage === true) };
  });
  app.post('/api/media/:id/relink', async (request, reply) => {
    const { path: filename } = registerSchema.parse(request.body);
    return reply
      .code(202)
      .send({ job: library.relink(idParams.parse(request.params).id, footage.validateManualPath(filename)) });
  });
  app.get('/api/media/:id/motion', async (request) => {
    const asset = library.get(idParams.parse(request.params).id);
    await assertSourceIdentity(asset.sourcePath, asset.fingerprint);
    return { analysis: await library.motion(asset.id), job: library.motionJob(asset.id) };
  });
  app.post('/api/media/:id/motion', async (request, reply) => {
    z.object({}).strict().parse(request.body);
    return reply.code(202).send({ job: library.analyseMotion(idParams.parse(request.params).id) });
  });
  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/media/:id/proxy',
    handler: async (request, reply) => {
      const asset = library.get(idParams.parse(request.params).id);
      await assertSourceIdentity(asset.sourcePath, asset.fingerprint);
      if (asset.status !== 'ready' || !asset.prepared)
        throw new ServiceError('The proxy is not verified and ready.', 409);
      await serveRegisteredFile(request, reply, library.proxyPath(asset), 'video/mp4');
    },
  });
  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/media/:id/source',
    handler: async (request, reply) => {
      const asset = library.get(idParams.parse(request.params).id);
      await assertSourceIdentity(asset.sourcePath, asset.fingerprint);
      await serveRegisteredFile(request, reply, asset.sourcePath, 'video/mp4');
    },
  });
  app.get('/api/media/:id/thumbnail/:frame', async (request, reply) => {
    const parameters = z.object({ id: idSchema, frame: z.coerce.number().int().nonnegative() }).parse(request.params);
    const asset = library.get(parameters.id);
    await assertSourceIdentity(asset.sourcePath, asset.fingerprint);
    if (!asset.prepared?.thumbnailFrames.includes(parameters.frame))
      throw new ServiceError('Indexed thumbnail not found.', 404);
    await serveRegisteredFile(request, reply, library.thumbnailPath(asset, parameters.frame), 'image/jpeg');
  });
  app.get('/api/audio', async (_request, reply) =>
    reply.send({ assets: await audio.availableList(), missing: await audio.missing() }),
  );
  app.get('/api/audio/roots', async () => ({ roots: await footage.roots() }));
  app.get('/api/audio/browse', async (request) => {
    const query = footageQuerySchema.parse(request.query);
    return footage.browseAudio(query.rootId, query.directory);
  });
  app.post('/api/audio/register-selected', async (request, reply) => {
    const selected = footage.validateAudioPath(registerSchema.parse(request.body).path);
    return reply.code(202).send(await audio.register(selected));
  });
  app.post('/api/audio/register', async (request, reply) =>
    reply.code(202).send(await audio.register(registerSchema.parse(request.body).path)),
  );
  app.post('/api/audio/:id/prepare', async (request, reply) => {
    z.object({}).strict().parse(request.body);
    return reply.code(202).send({ job: await audio.prepare(idParams.parse(request.params).id) });
  });
  app.post('/api/audio/:id/relink', async (request, reply) => {
    const { path: filename } = registerSchema.parse(request.body);
    const job = await audio.relink(idParams.parse(request.params).id, footage.validateManualPath(filename));
    return reply.code(202).send({ job });
  });
  app.post('/api/relink-folder', async (request, reply) => {
    const directory = footage.validateManualPath(importSchema.parse(request.body).directory);
    const job = await submitFolderRelink(jobs, config.dataDir, [library, audio], directory);
    return reply.code(202).send({ job });
  });
  app.route({
    method: ['GET', 'HEAD'],
    url: '/api/audio/:id/playback',
    handler: async (request, reply) => {
      const asset = await audio.assertReady(idParams.parse(request.params).id);
      await serveRegisteredFile(request, reply, audio.playbackPath(asset), 'application/octet-stream');
    },
  });
  app.get('/api/audio/:id/waveform', async (request) => ({
    waveform: (await audio.assertReady(idParams.parse(request.params).id)).waveform,
  }));
  app.get('/api/audio/:id/analysis', async (request) => {
    const asset = audio.get(idParams.parse(request.params).id);
    await assertSourceIdentity(asset.sourcePath, asset.fingerprint);
    return { analysis: await audio.analysis(asset.id), job: audio.analysisJob(asset.id) };
  });
  app.post('/api/audio/:id/analysis', async (request, reply) => {
    z.object({}).strict().parse(request.body);
    return reply.code(202).send({ job: audio.analyse(idParams.parse(request.params).id) });
  });
  app.get('/api/projects', async () => ({ projects: await projects.list() }));
  app.post('/api/projects', async (request, reply) =>
    reply.code(201).send({ document: await projects.create(createProjectSchema.parse(request.body).title) }),
  );
  app.get('/api/projects/:id', async (request) => ({
    document: await projects.load(idParams.parse(request.params).id),
  }));
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
    if (body.document.id !== idParams.parse(request.params).id)
      throw new ServiceError('Project ID must match its route.');
    await assertProjectSources(body.document, library, audio);
    return { document: await projects.save(body.document, body.expectedRevision) };
  });
  app.post('/api/projects/import', async (request, reply) => {
    const document = projects.decodeFile(importProjectSchema.parse(request.body).document);
    try {
      await assertProjectSources(document, library, audio);
    } catch (error) {
      if (!(error instanceof ServiceError && error.statusCode === 404)) throw error;
      throw new ServiceError(
        'This project file uses recordings or music that are not imported in this PasCap service. Nothing was created.',
        422,
      );
    }
    return reply.code(201).send({ document: await projects.save(document, 0) });
  });
  registerOperations(app, { projects, library, audio });
  app.get('/api/jobs', (_request, reply) => reply.send({ jobs: jobs.list() }));
  app.get('/api/jobs/:id', (request, reply) => reply.send({ job: jobs.get(idParams.parse(request.params).id) }));
  app.post('/api/jobs/:id/cancel', (request, reply) => {
    z.object({}).strict().parse(request.body);
    jobs.cancel(idParams.parse(request.params).id);
    return reply.send({ job: jobs.get(idParams.parse(request.params).id) });
  });
  app.post('/api/reference', (request, reply) =>
    reply.send({ job: startReference(referenceSchema.parse(request.body).document, library) }),
  );
  app.post('/api/exports/preflight', async (request) => {
    const body = exportRequestSchema.parse(request.body);
    return { space: await preflightExport(body.document, body.profile, library, (id) => audio.get(id)) };
  });
  app.post('/api/exports', async (request, reply) => {
    const body = exportRequestSchema.parse(request.body);
    requireExportReserve(await preflightExport(body.document, body.profile, library, (id) => audio.get(id)));
    return reply
      .code(202)
      .send({ job: startExport(body.document, body.profile, library, (id) => audio.get(id), body.outputName) });
  });
  for (const type of ['reference', 'export', 'receipt'] as const) {
    app.route({
      method: ['GET', 'HEAD'],
      url: `/api/jobs/:id/${type}`,
      handler: async (request, reply) => {
        const id = idParams.parse(request.params).id;
        if (jobs.get(id).state !== 'completed') throw new ServiceError('Reference output is not complete.', 409);
        const filename = type === 'receipt' ? 'receipt.json' : `${type}.mp4`;
        if (type !== 'receipt' && jobs.get(id).kind !== type)
          throw new ServiceError('This job has no requested output.', 404);
        await serveRegisteredFile(
          request,
          reply,
          path.join(config.dataDir, 'renders', id, filename),
          type === 'receipt' ? 'application/json' : 'video/mp4',
          type === 'export' ? exportFilename(jobs.get(id).label) : undefined,
        );
      },
    });
  }
  try {
    await access(path.join(config.webDir, 'index.html'));
    await app.register(fastifyStatic, {
      root: config.webDir,
      wildcard: false,
      index: ['index.html'],
      dotfiles: 'deny',
    });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    app.get('/', (_request, reply) =>
      reply.send({ name: 'PasCap', message: 'Use the Vite development page, or build the frontend first.' }),
    );
  }
  return { app, library, audio, jobs, projects, config };
}
