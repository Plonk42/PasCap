import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AudioAsset } from '../../src/shared/audio.js';
import type { ExportPreflight } from '../../src/shared/export-space.js';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import type { MediaJob } from '../../src/shared/media.js';
import { createClip, createProject } from '../../src/shared/model.js';
import { api, ApiError, request, type ServiceHealth } from '../../src/web/api.js';
import { unsupportedProject } from './project-fixtures.js';

const schema = z.object({ value: z.string() }).strict();
const health: ServiceHealth = {
  name: 'PasCap',
  milestone: 'editing-and-export',
  frameRate: '30000/1001',
  workerConcurrency: 1,
};
const project = createProject('flight', 'Flight');
const saved = { ...project, revision: 1 };
const space: ExportPreflight = {
  directory: '/fixtures/cache/renders',
  availableBytes: 10 * 1024 ** 3,
  estimate: { losslessBytes: 400, encodedBytes: 200, audioBytes: 0, overheadBytes: 100, totalBytes: 700 },
  status: 'available',
  checkedAt: '2026-10-04T10:00:00Z',
};
const job: MediaJob = {
  id: 'job-1',
  kind: 'prepare',
  label: 'Preparation',
  state: 'queued',
  progress: 0,
  message: 'Queued',
  createdAt: '2026-10-03T12:00:00Z',
  finishedAt: null,
  outputUrl: null,
  receiptUrl: null,
};
const audio: AudioAsset = {
  id: 'music-1',
  name: 'music.wav',
  sourcePath: '/fixtures/music.wav',
  fingerprint: { algorithm: 'sampled-sha256-v1', digest: 'a'.repeat(64), size: 100, mtimeMs: 1, device: 1, inode: 1 },
  metadata: { codec: 'pcm_s16le', sampleRate: 48_000, channels: 2, durationSeconds: 2, frameCount: 59 },
  status: 'registered',
  error: null,
  waveform: [],
};
let fetchMock = vi.fn<typeof fetch>();

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
function sentSignal(): AbortSignal {
  const signal = fetchMock.mock.calls[0]?.[1]?.signal;
  expect(signal).toBeInstanceOf(AbortSignal);
  return signal as AbortSignal;
}
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('registered API methods', () => {
  it('browses a service-side path using encoded query parameters and no request body', async () => {
    const directory = '/approved/Camera footage & rushes';
    const listing = {
      rootId: 'root-0',
      directory,
      parent: '/approved',
      entries: [],
      ignored: 0,
      truncated: false,
      warnings: [],
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(listing));
    expect(await api.browseFootage('root-0', directory)).toEqual(listing);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/footage?rootId=root-0&directory=%2Fapproved%2FCamera+footage+%26+rushes',
    );
    expect(fetchMock.mock.calls[0]![1]?.body).toBeUndefined();
  });

  const cases = [
    {
      name: 'health',
      call: () => api.health(),
      url: '/api/health',
      method: 'GET',
      body: undefined,
      response: health,
      expected: health,
      status: 200,
    },
    {
      name: 'library',
      call: () => api.library(),
      url: '/api/media',
      method: 'GET',
      body: undefined,
      response: { assets: [] },
      expected: { assets: [] },
      status: 200,
    },
    {
      name: 'jobs',
      call: () => api.jobs(),
      url: '/api/jobs',
      method: 'GET',
      body: undefined,
      response: { jobs: [job] },
      expected: { jobs: [job] },
      status: 200,
    },
    {
      name: 'importFolder',
      call: () => api.importFolder('/fixtures'),
      url: '/api/media/import',
      method: 'POST',
      body: { directory: '/fixtures' },
      response: { assets: [], errors: [], ignored: 0, added: 0, existing: 0, jobs: [job], queueErrors: [] },
      expected: { assets: [], errors: [], ignored: 0, added: 0, existing: 0, jobs: [job], queueErrors: [] },
      status: 202,
    },
    {
      name: 'registerPaths',
      call: () => api.registerPaths(['/fixtures/movie.mp4']),
      url: '/api/media/register-paths',
      method: 'POST',
      body: { paths: ['/fixtures/movie.mp4'] },
      response: { assets: [], errors: [], ignored: 0, added: 0, existing: 1, jobs: [], queueErrors: [] },
      expected: { assets: [], errors: [], ignored: 0, added: 0, existing: 1, jobs: [], queueErrors: [] },
      status: 202,
    },
    {
      name: 'footageRoots',
      call: () => api.footageRoots(),
      url: '/api/footage/roots',
      method: 'GET',
      body: undefined,
      response: { roots: [] },
      expected: { roots: [] },
      status: 200,
    },
    {
      name: 'browseFootage',
      call: () => api.browseFootage('root-0'),
      url: '/api/footage?rootId=root-0',
      method: 'GET',
      body: undefined,
      response: {
        rootId: 'root-0',
        directory: '/fixtures',
        parent: null,
        entries: [],
        ignored: 0,
        truncated: false,
        warnings: [],
      },
      expected: {
        rootId: 'root-0',
        directory: '/fixtures',
        parent: null,
        entries: [],
        ignored: 0,
        truncated: false,
        warnings: [],
      },
      status: 200,
    },
    {
      name: 'prepare',
      call: () => api.prepare('video-1'),
      url: '/api/media/video-1/prepare',
      method: 'POST',
      body: {},
      response: { job },
      expected: { job },
      status: 200,
    },
    {
      name: 'cancel',
      call: () => api.cancel(job.id),
      url: '/api/jobs/job-1/cancel',
      method: 'POST',
      body: {},
      response: { job },
      expected: { job },
      status: 200,
    },
    {
      name: 'projects',
      call: () => api.projects(),
      url: '/api/projects',
      method: 'GET',
      body: undefined,
      response: { projects: [] },
      expected: { projects: [] },
      status: 200,
    },
    {
      name: 'createProject',
      call: () => api.createProject('Flight'),
      url: '/api/projects',
      method: 'POST',
      body: { title: 'Flight' },
      response: { document: saved },
      expected: { document: saved },
      status: 201,
    },
    {
      name: 'deleteProject',
      call: () => api.deleteProject('flight', 1),
      url: '/api/projects/flight',
      method: 'DELETE',
      body: { expectedRevision: 1 },
      response: { deleted: true },
      expected: { deleted: true },
      status: 200,
    },
    {
      name: 'deleteUnavailableProject',
      call: () => api.deleteProject('old', null),
      url: '/api/projects/old',
      method: 'DELETE',
      body: { expectedRevision: null },
      response: { deleted: true },
      expected: { deleted: true },
      status: 200,
    },
    {
      name: 'load',
      call: () => api.load(project.id),
      url: '/api/projects/flight',
      method: 'GET',
      body: undefined,
      response: { document: project },
      expected: { document: project },
      status: 200,
    },
    {
      name: 'save',
      call: () => api.save(project, 0),
      url: '/api/projects/flight',
      method: 'PUT',
      body: { document: project, expectedRevision: 0 },
      response: { document: saved },
      expected: saved,
      status: 200,
    },
    {
      name: 'audio',
      call: () => api.audio(),
      url: '/api/audio',
      method: 'GET',
      body: undefined,
      response: { assets: [audio] },
      expected: { assets: [audio] },
      status: 200,
    },
    {
      name: 'importAudio',
      call: () => api.importAudio(audio.sourcePath),
      url: '/api/audio/register',
      method: 'POST',
      body: { path: audio.sourcePath },
      response: { asset: audio, job: { ...job, kind: 'audio' } },
      expected: { asset: audio, job: { ...job, kind: 'audio' } },
      status: 202,
    },
    {
      name: 'prepareAudio',
      call: () => api.prepareAudio(audio.id),
      url: '/api/audio/music-1/prepare',
      method: 'POST',
      body: {},
      response: { job: { ...job, kind: 'audio' } },
      expected: { job: { ...job, kind: 'audio' } },
      status: 202,
    },
    {
      name: 'exportPreflight',
      call: () => api.exportPreflight(project, 'draft720'),
      url: '/api/exports/preflight',
      method: 'POST',
      body: { document: project, profile: 'draft720' },
      response: { space },
      expected: { space },
      status: 200,
    },
    {
      name: 'export',
      call: () => api.export(project, 'draft720'),
      url: '/api/exports',
      method: 'POST',
      body: { document: project, profile: 'draft720' },
      response: { job: { ...job, kind: 'export' } },
      expected: { job: { ...job, kind: 'export' } },
      status: 202,
    },
    {
      name: 'reference',
      call: () => api.reference(project),
      url: '/api/reference',
      method: 'POST',
      body: { document: project },
      response: { job: { ...job, kind: 'reference' } },
      expected: { job: { ...job, kind: 'reference' } },
      status: 200,
    },
  ];
  it.each(cases)(
    'preserves the $name route, method, body and validated result',
    async ({ call, url, method, body, response, expected, status }) => {
      fetchMock.mockResolvedValueOnce(jsonResponse(response, status));
      expect(await call()).toEqual(expected);
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        url,
        expect.objectContaining({
          method,
          headers: { 'Content-Type': 'application/json', 'X-PasCap-Client': 'preview-lab' },
          signal: expect.any(AbortSignal),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(body === undefined ? undefined : JSON.stringify(body));
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    { name: 'missing fields', response: { name: 'PasCap' } },
    { name: 'wrong service', response: { ...health, name: 'Another service' } },
    { name: 'wrong milestone', response: { ...health, milestone: 'old' } },
    { name: 'wrong frame rate', response: { ...health, frameRate: '30/1' } },
    { name: 'wrong concurrency', response: { ...health, workerConcurrency: 2 } },
    { name: 'invented readiness flag', response: { ...health, ready: true } },
  ])('does not mistake $name for health/readiness', async ({ response }) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(response));
    await expect(api.health()).rejects.toMatchObject({
      name: 'ApiError',
      status: 200,
      kind: 'response',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retains strict nested project validation without filling in old or missing fields', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ document: { ...project, schemaVersion: 2 } }));
    await expect(api.load(project.id)).rejects.toMatchObject({ status: 200, kind: 'response' });
    fetchMock.mockResolvedValueOnce(jsonResponse({ document: { ...saved, unexpected: true } }));
    await expect(api.save(project, 0)).rejects.toMatchObject({ status: 200, kind: 'response' });
  });

  it('uses complete schema-9 project mocks and rejects a version-8 response without changing it', async () => {
    expect(project.schemaVersion).toBe(9);
    expect(project.layers[0]!.keyframes).toEqual([]);
    const unsupported = unsupportedProject(8, project.id, project.title);
    const before = JSON.stringify(unsupported);
    fetchMock.mockResolvedValueOnce(jsonResponse({ document: unsupported }));
    await expect(api.load(project.id)).rejects.toMatchObject({ status: 200, kind: 'response', retryable: false });
    expect(JSON.stringify(unsupported)).toBe(before);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('validates all nine required nullable members in a shared row point, including zero participation', async () => {
    const point = {
      frame: 100,
      interpolation: 'linear' as const,
      values: { ...EMPTY_KEY_VALUES, exposure: 0, opacity: 0 },
    };
    const document = { ...project, layers: [{ ...project.layers[0]!, keyframes: [point] }] };
    fetchMock.mockResolvedValueOnce(jsonResponse({ document }));
    expect(await api.load(project.id)).toEqual({ document });
    const { shadows: _shadows, ...incomplete } = point.values;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        document: { ...document, layers: [{ ...document.layers[0], keyframes: [{ ...point, values: incomplete }] }] },
      }),
    );
    await expect(api.load(project.id)).rejects.toMatchObject({ status: 200, kind: 'response', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['clip opacity', 'layerOpacity', 'clipOpacity'])(
    'rejects a removed %s in a v9 response without dropping it or retrying',
    async (removed) => {
      const layer = project.layers[0]!;
      const legacyLayer =
        removed === 'clip opacity'
          ? layer
          : {
              ...layer,
              keyframes: [
                {
                  frame: 0,
                  interpolation: 'linear',
                  values: { ...EMPTY_KEY_VALUES, opacity: 0.5, [removed]: null },
                },
              ],
            };
      const response = {
        document: {
          ...project,
          layers: [legacyLayer],
          clips: removed === 'clip opacity' ? [{ ...createClip('legacy', 'video', 0, 10), opacity: 1 }] : project.clips,
        },
      };
      const bytes = JSON.stringify(response);
      fetchMock.mockResolvedValueOnce(jsonResponse(response));
      await expect(api.load(project.id)).rejects.toMatchObject({ status: 200, kind: 'response', retryable: false });
      expect(JSON.stringify(response)).toBe(bytes);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

describe('API response and transport failures', () => {
  it('reports an interrupted read-only preflight without claiming that a render may have been submitted', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Disconnected'));
    const error: unknown = await api.exportPreflight(project, 'final4k').catch((cause: unknown) => cause);
    expect(error).toMatchObject({ status: 0, kind: 'network', retryable: true });
    expect((error as ApiError).message).not.toContain('may still have completed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    { ...space, availableBytes: -1 },
    { ...space, status: 'guaranteed-fit' },
    { ...space, estimate: { totalBytes: 700 } },
    { ...space, checkedAt: 'unknown' },
    { ...space, extra: true },
  ])('rejects an incompatible storage report rather than assuming that the disk is usable', async (invalid) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ space: invalid }));
    await expect(api.exportPreflight(project, 'draft720')).rejects.toMatchObject({
      kind: 'response',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('keeps the original four-argument request signature', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ value: 'saved' }));
    expect(await request('/api/test', schema, 'PUT', { value: 'draft' })).toEqual({ value: 'saved' });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT', body: '{"value":"draft"}' });
  });

  it.each([400, 409, 422, 500, 503])('preserves server error details and HTTP %i', async (status) => {
    const message = 'Original service explanation; keep the current draft.';
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: message }, status));
    const error: unknown = await request('/api/test', schema).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ name: 'ApiError', status, kind: 'http', message });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { name: 'HTML gateway error', body: '<html>Private upstream page</html>', status: 502 },
    { name: 'truncated JSON error', body: '{"error":', status: 500 },
    { name: 'empty conflict', body: '', status: 409 },
    { name: 'incorrect JSON error shape', body: '{"message":"private diagnostic"}', status: 403 },
    { name: 'non-string error', body: '{"error":{"private":"diagnostic"}}', status: 422 },
    { name: 'blank error', body: '{"error":"  "}', status: 503 },
  ])('turns $name into an actionable error rather than a parser exception', async ({ body, status }) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { status }));
    const error: unknown = await request('/api/test', schema).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, kind: 'http', message: expect.stringContaining(`HTTP ${status}`) });
    expect((error as ApiError).message).toMatch(/Check|Keep/);
    expect((error as ApiError).message).not.toContain('private');
    expect((error as ApiError).message).not.toContain('<html>');
    if (status === 409) expect((error as ApiError).message).toContain('do not overwrite');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { name: 'missing data', value: {} },
    { name: 'wrong data type', value: { value: 7 } },
    { name: 'extra field in a strict schema', value: { value: 'valid', unexpected: true } },
    { name: 'null payload', value: null },
  ])('rejects successful HTTP responses with $name', async ({ value }) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(value));
    await expect(request('/api/test', schema)).rejects.toMatchObject({
      status: 200,
      kind: 'response',
      retryable: false,
      message: expect.stringContaining('same PasCap version'),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { name: 'HTML app fallback', body: '<html>Not the service</html>', status: 200 },
    { name: 'truncated success JSON', body: '{"value":', status: 200 },
    { name: 'empty success', body: null, status: 204 },
  ])('rejects $name without exposing its body', async ({ body, status }) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { status }));
    await expect(request('/api/test', schema)).rejects.toMatchObject({ name: 'ApiError', status, kind: 'response' });
  });

  it.each([
    new TypeError('Private network diagnostic'),
    new Error('Private transport diagnostic'),
    'Private rejected value',
  ])('makes network failure actionable without leaking transport details', async (cause) => {
    fetchMock.mockRejectedValueOnce(cause);
    await expect(request('/api/test?private=value', schema)).rejects.toMatchObject({
      status: 0,
      kind: 'network',
      retryable: true,
      message: 'Cannot reach the local PasCap service. Check that it is running, then retry.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a dropped response stream as a network failure, not a Zod error', async () => {
    const response = jsonResponse({ value: 'unread' });
    vi.spyOn(response, 'json').mockRejectedValueOnce(new TypeError('Private connection reset'));
    fetchMock.mockResolvedValueOnce(response);
    await expect(request('/api/test', schema)).rejects.toMatchObject({
      status: 0,
      kind: 'network',
      retryable: true,
      message: expect.stringContaining('interrupted while reading'),
    });
  });

  it.each([409, 503])('preserves an already-received HTTP %i when its error body disconnects', async (status) => {
    const response = jsonResponse({ error: 'Unread explanation' }, status);
    vi.spyOn(response, 'json').mockRejectedValueOnce(new TypeError('Connection reset'));
    fetchMock.mockResolvedValueOnce(response);
    await expect(request('/api/test', schema, 'PUT', {})).rejects.toMatchObject({
      status,
      kind: 'http',
      retryable: status === 503,
    });
  });

  it('warns that an interrupted write may already have completed and does not repeat it', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Disconnected'));
    await expect(api.save(project, 0)).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining('may still have completed'),
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects unencodable data before sending anything', async () => {
    const body: Record<string, unknown> = {};
    body['self'] = body;
    await expect(request('/api/test', schema, 'POST', body)).rejects.toMatchObject({
      status: 0,
      kind: 'request',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { name: 'function', body: () => null },
    { name: 'symbol', body: Symbol('not-json') },
    { name: 'bigint', body: 1n },
  ])('rejects a root $name instead of silently omitting its request body', async ({ body }) => {
    await expect(request('/api/test', schema, 'POST', body)).rejects.toMatchObject({
      status: 0,
      kind: 'request',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    'rejects invalid timeout %s without sending a request',
    async (timeoutMs) => {
      await expect(request('/api/test', schema, 'GET', undefined, { timeoutMs })).rejects.toMatchObject({
        status: 0,
        kind: 'request',
        retryable: false,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe('bounded request deadlines and cancellation', () => {
  it('uses the 15-second read deadline for preflight POST and does not retry it', async () => {
    const gate = deferred<Response>();
    fetchMock.mockReturnValueOnce(gate.promise);
    const outcome = api.exportPreflight(project, 'draft720').catch((cause: unknown) => cause);
    await vi.advanceTimersByTimeAsync(15_000);
    const error = (await outcome) as ApiError;
    expect(error).toMatchObject({ status: 0, kind: 'timeout', message: expect.stringContaining('15 seconds') });
    expect(error.message).not.toContain('may still have completed');
    expect(sentSignal().aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    gate.resolve(jsonResponse({ space }));
  });
  it('times out GET at 15 seconds even if the transport ignores abort', async () => {
    const gate = deferred<Response>();
    fetchMock.mockReturnValueOnce(gate.promise);
    const outcome = request('/api/test', schema).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(sentSignal().aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({
      status: 0,
      kind: 'timeout',
      retryable: true,
      message: expect.stringContaining('15 seconds'),
    });
    expect(sentSignal().aborted).toBe(true);
    gate.resolve(jsonResponse({ value: 'too late' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['POST', 'PUT'])('allows %s up to 120 seconds without automatic retry', async (method) => {
    const gate = deferred<Response>();
    fetchMock.mockReturnValueOnce(gate.promise);
    const outcome = request('/api/test', schema, method, {}).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(sentSignal().aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({
      status: 0,
      kind: 'timeout',
      message: expect.stringContaining('may still have completed'),
    });
    expect(sentSignal().aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    gate.resolve(jsonResponse({ value: 'late write result' }));
  });

  it.each([
    {
      name: 'folder import',
      call: () => api.importFolder('/fixtures'),
      response: { assets: [], errors: [], ignored: 0, added: 0, existing: 0, jobs: [], queueErrors: [] },
    },
    {
      name: 'audio probe',
      call: () => api.importAudio(audio.sourcePath),
      response: { asset: audio, job: { ...job, kind: 'audio' } },
    },
  ])('preserves a ten-minute allowance for $name', async ({ call, response }) => {
    const gate = deferred<Response>();
    fetchMock.mockReturnValueOnce(gate.promise);
    const pending = call();
    await vi.advanceTimersByTimeAsync(599_999);
    expect(sentSignal().aborted).toBe(false);
    gate.resolve(jsonResponse(response, 202));
    await expect(pending).resolves.toEqual(response);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still bounds a stalled import at ten minutes', async () => {
    const gate = deferred<Response>();
    fetchMock.mockReturnValueOnce(gate.promise);
    const outcome = api.importFolder('/fixtures').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await outcome).toMatchObject({
      status: 0,
      kind: 'timeout',
      message: expect.stringContaining('600 seconds'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentSignal().aborted).toBe(true);
    gate.resolve(jsonResponse({ assets: [], errors: [], ignored: 0 }));
  });

  it('keeps the deadline active while the response body is being decoded', async () => {
    const gate = deferred<unknown>();
    const response = jsonResponse({ value: 'waiting' });
    vi.spyOn(response, 'json').mockReturnValueOnce(gate.promise);
    fetchMock.mockResolvedValueOnce(response);
    const outcome = request('/api/test', schema, 'GET', undefined, { timeoutMs: 100 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toMatchObject({ status: 0, kind: 'timeout' });
    expect(sentSignal().aborted).toBe(true);
    gate.resolve({ value: 'too late' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([409, 503])('keeps known HTTP %i authoritative when its error-body deadline expires', async (status) => {
    const gate = deferred<unknown>();
    const response = jsonResponse({ error: 'Waiting' }, status);
    vi.spyOn(response, 'json').mockReturnValueOnce(gate.promise);
    fetchMock.mockResolvedValueOnce(response);
    const outcome = request('/api/test', schema, 'PUT', {}, { timeoutMs: 100 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toMatchObject({ status, kind: 'http', retryable: status === 503 });
    expect(sentSignal().aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    gate.resolve({ error: 'Late error explanation' });
  });

  it('does not fetch when the caller has already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(request('/api/test', schema, 'GET', undefined, { signal: controller.signal })).rejects.toMatchObject({
      status: 0,
      kind: 'aborted',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels in flight, removes listeners, and does not accept a late success', async () => {
    const gate = deferred<Response>();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    fetchMock.mockReturnValueOnce(gate.promise);
    const outcome = request('/api/test', schema, 'PUT', {}, { signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    controller.abort();
    expect(await outcome).toMatchObject({
      status: 0,
      kind: 'aborted',
      retryable: false,
      message: expect.stringContaining('may still have completed'),
    });
    expect(sentSignal().aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    gate.resolve(jsonResponse({ value: 'late' }));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cleans up abort listeners after a normal successful response', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    fetchMock.mockResolvedValueOnce(jsonResponse({ value: 'ready' }));
    expect(await request('/api/test', schema, 'GET', undefined, { signal: controller.signal })).toEqual({
      value: 'ready',
    });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(sentSignal().aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('API recovery classification', () => {
  it.each([
    [0, 'http', true],
    [0, 'network', true],
    [0, 'timeout', true],
    [408, 'http', true],
    [429, 'http', true],
    [500, 'http', true],
    [599, 'http', true],
    [600, 'http', false],
    [409, 'http', false],
    [422, 'http', false],
    [200, 'response', false],
    [0, 'aborted', false],
    [0, 'request', false],
  ] as const)('classifies status %i / %s as retryable=%s', (status, kind, retryable) => {
    expect(new ApiError('Failure', status, kind).retryable).toBe(retryable);
  });
});
