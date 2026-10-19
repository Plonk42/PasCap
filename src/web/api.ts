import { z } from 'zod';
import { audioAssetSchema } from '../shared/audio.js';
import { exportPreflightSchema } from '../shared/export-space.js';
import type { ExportProfile } from '../shared/export.js';
import { audioDirectorySchema, footageDirectorySchema, footageRootSchema } from '../shared/footage.js';
import { jobSchema, mediaAssetSchema } from '../shared/media.js';
import { motionAnalysisSchema } from '../shared/motion-analysis.js';
import { idSchema, projectSchema, type ProjectDocument } from '../shared/model.js';
import { projectSummarySchema } from '../shared/projects.js';

export type ApiErrorKind = 'http' | 'network' | 'timeout' | 'response' | 'aborted' | 'request';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: ApiErrorKind = 'http',
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get retryable(): boolean {
    return (
      ['http', 'network', 'timeout'].includes(this.kind) &&
      (this.status === 0 || this.status === 408 || this.status === 429 || (this.status >= 500 && this.status <= 599))
    );
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  readOnly?: boolean;
}

const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 120_000;
// Folder registration probes every source serially; audio registration also probes before replying.
const IMPORT_TIMEOUT_MS = 600_000;
const importResultSchema = z.object({
  assets: z.array(mediaAssetSchema),
  errors: z.array(z.object({ path: z.string(), message: z.string() })),
  ignored: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  existing: z.number().int().nonnegative(),
  jobs: z.array(jobSchema),
  queueErrors: z.array(z.object({ mediaId: z.string(), message: z.string() })),
});
const errorSchema = z.object({ error: z.string().refine((message) => message.trim().length > 0) });
const healthSchema = z
  .object({
    name: z.literal('PasCap'),
    milestone: z.literal('editing-and-export'),
    frameRate: z.literal('30000/1001'),
    workerConcurrency: z.literal(1),
  })
  .strict();
export type ServiceHealth = z.infer<typeof healthSchema>;

function responseFailure(status: number, ok: boolean): ApiError {
  let action = 'Check that the local PasCap service is running. Resolve the reported HTTP error before trying again.';
  if (status === 409)
    action = 'Keep the current draft and reload the latest project before saving again; do not overwrite it.';
  else if (ok)
    action =
      'Keep the current draft, check that the page and local service use the same PasCap version, and refresh before continuing.';
  return new ApiError(
    `The local service returned an unreadable or incompatible response (HTTP ${status}). ${action}`,
    status,
    ok ? 'response' : 'http',
  );
}

/** One attempt only, including for writes. The deadline covers both fetch and response decoding. */
export async function request<T>(
  url: string,
  schema: z.ZodType<T>,
  method = 'GET',
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const readOnly = options.readOnly === true || ['GET', 'HEAD'].includes(method.toUpperCase());
  const timeoutMs = options.timeoutMs ?? (readOnly ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new ApiError('The request timeout must be a positive, finite number of milliseconds.', 0, 'request');
  }
  const uncertainty = readOnly
    ? ''
    : ' The operation may still have completed; check the latest project or job state before repeating it.';
  const cancelled = (): ApiError => new ApiError(`Request cancelled.${uncertainty}`, 0, 'aborted');
  if (options.signal?.aborted) throw cancelled();
  let payload: string | undefined;
  try {
    if (body !== undefined) payload = JSON.stringify(body);
    if (body !== undefined && payload === undefined) throw new TypeError('Not a JSON value.');
  } catch {
    throw new ApiError(
      'The request could not be encoded as JSON. Check the current data before trying again.',
      0,
      'request',
    );
  }

  const controller = new AbortController();
  let interruption: ApiError | null = null;
  let failedStatus: number | null = null;
  let rejectInterrupted!: (error: ApiError) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = reject;
  });
  const interrupt = (error: ApiError): void => {
    if (interruption !== null) return;
    interruption = error;
    rejectInterrupted(error);
    controller.abort();
  };
  const onAbort = (): void => interrupt(cancelled());
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    // A received HTTP conflict remains authoritative even if its explanation never arrives.
    const error =
      failedStatus === null
        ? new ApiError(
            `The local PasCap service did not respond within ${timeoutMs / 1000} seconds. Check that it is running and try again.${uncertainty}`,
            0,
            'timeout',
          )
        : responseFailure(failedStatus, false);
    interrupt(error);
  }, timeoutMs);
  const perform = async (): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-PasCap-Client': 'preview-lab' },
        signal: controller.signal,
        ...(payload === undefined ? {} : { body: payload }),
      });
    } catch {
      throw (
        interruption ??
        new ApiError(
          `Cannot reach the local PasCap service. Check that it is running, then retry.${uncertainty}`,
          0,
          'network',
        )
      );
    }
    if (interruption !== null) throw interruption;
    if (!response.ok) failedStatus = response.status;
    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      if (interruption !== null) throw interruption;
      if (!response.ok || error instanceof SyntaxError) throw responseFailure(response.status, response.ok);
      throw new ApiError(
        `The connection to the local PasCap service was interrupted while reading its response. Check the service and retry.${uncertainty}`,
        0,
        'network',
      );
    }
    if (interruption !== null) throw interruption;
    if (!response.ok) {
      const error = errorSchema.safeParse(json);
      throw error.success ? new ApiError(error.data.error, response.status) : responseFailure(response.status, false);
    }
    try {
      return schema.parse(json);
    } catch {
      throw responseFailure(response.status, true);
    }
  };
  try {
    return await Promise.race([perform(), interrupted]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export const api = {
  // A validated response is readiness: the actual service has no separate "ready" field.
  health: (options?: RequestOptions) => request('/api/health', healthSchema, 'GET', undefined, options),
  library: (options?: RequestOptions) =>
    request(
      '/api/media',
      z.object({ assets: z.array(mediaAssetSchema), missing: z.array(idSchema) }),
      'GET',
      undefined,
      options,
    ),
  jobs: (options?: RequestOptions) =>
    request('/api/jobs', z.object({ jobs: z.array(jobSchema) }), 'GET', undefined, options),
  importFolder: (directory: string) =>
    request('/api/media/import', importResultSchema, 'POST', { directory }, { timeoutMs: IMPORT_TIMEOUT_MS }),
  footageRoots: (options?: RequestOptions) =>
    request(
      '/api/footage/roots',
      z.object({ roots: z.array(footageRootSchema).max(32) }).strict(),
      'GET',
      undefined,
      options,
    ),
  browseFootage: (rootId: string, directory?: string, options?: RequestOptions) => {
    const query = new URLSearchParams({ rootId });
    if (directory !== undefined) query.set('directory', directory);
    return request(`/api/footage?${query}`, footageDirectorySchema, 'GET', undefined, options);
  },
  /** A small JPEG of a browsed recording; the original itself is never sent. */
  footagePreview: async (path: string, signal: AbortSignal): Promise<Blob> => {
    let response: Response;
    try {
      response = await fetch(`/api/footage/preview?${new URLSearchParams({ path })}`, { signal });
    } catch {
      throw new ApiError(
        signal.aborted ? 'Request cancelled.' : 'Cannot reach the local PasCap service.',
        0,
        'network',
      );
    }
    if (!response.ok) {
      const error = errorSchema.safeParse(await response.json().catch(() => null));
      throw new ApiError(
        error.success ? error.data.error : `Preview unavailable (HTTP ${response.status}).`,
        response.status,
      );
    }
    const image = await response.blob();
    if (image.type !== 'image/jpeg') throw responseFailure(response.status, true);
    return image;
  },
  registerPaths: (paths: readonly string[]) =>
    request('/api/media/register-paths', importResultSchema, 'POST', { paths }, { timeoutMs: IMPORT_TIMEOUT_MS }),
  registerMedia: (path: string) =>
    request(
      '/api/media/register',
      z.object({ asset: mediaAssetSchema, job: jobSchema.nullable() }).strict(),
      'POST',
      { path },
      { timeoutMs: IMPORT_TIMEOUT_MS },
    ),
  prepare: (id: string, blackOutDamage = false) =>
    request(
      `/api/media/${id}/prepare`,
      z.object({ job: jobSchema }),
      'POST',
      blackOutDamage ? { blackOutDamage: true } : {},
    ),
  /** The cached camera-motion analysis of the current proxy, or null, and its queued or running job. */
  motion: (id: string, options?: RequestOptions) =>
    request(
      `/api/media/${id}/motion`,
      z.object({ analysis: motionAnalysisSchema.nullable(), job: jobSchema.nullable() }),
      'GET',
      undefined,
      options,
    ),
  /** Queues the camera-motion analysis that steadiest-range suggestions need. */
  analyseMotion: (id: string) => request(`/api/media/${id}/motion`, z.object({ job: jobSchema }), 'POST', {}),
  /** Queues a full-content check of the moved copy; the job's outcome is the answer. */
  relinkMedia: (id: string, path: string) =>
    request(`/api/media/${id}/relink`, z.object({ job: jobSchema }), 'POST', { path }),
  /** Queues one search below the folder for every missing video and music original. */
  relinkFolder: (directory: string) =>
    request('/api/relink-folder', z.object({ job: jobSchema }), 'POST', { directory }),
  cancel: (id: string) => request(`/api/jobs/${id}/cancel`, z.object({ job: jobSchema }), 'POST', {}),
  projects: (options?: RequestOptions) =>
    request('/api/projects', z.object({ projects: z.array(projectSummarySchema) }), 'GET', undefined, options),
  createProject: (title: string) => request('/api/projects', z.object({ document: projectSchema }), 'POST', { title }),
  importProject: (document: unknown) =>
    request('/api/projects/import', z.object({ document: projectSchema }), 'POST', { document }),
  deleteProject: (id: string, expectedRevision: number | null) =>
    request(`/api/projects/${id}`, z.object({ deleted: z.literal(true) }), 'DELETE', { expectedRevision }),
  load: (id: string, options?: RequestOptions) =>
    request(`/api/projects/${id}`, z.object({ document: projectSchema }), 'GET', undefined, options),
  save: (document: ProjectDocument, expectedRevision: number) =>
    request(`/api/projects/${document.id}`, z.object({ document: projectSchema }), 'PUT', {
      document,
      expectedRevision,
    }).then((result) => result.document),
  audio: (options?: RequestOptions) =>
    request(
      '/api/audio',
      z.object({ assets: z.array(audioAssetSchema), missing: z.array(idSchema) }),
      'GET',
      undefined,
      options,
    ),
  audioRoots: (options?: RequestOptions) =>
    request(
      '/api/audio/roots',
      z.object({ roots: z.array(footageRootSchema).max(32) }).strict(),
      'GET',
      undefined,
      options,
    ),
  browseAudio: (rootId: string, directory?: string, options?: RequestOptions) => {
    const query = new URLSearchParams({ rootId });
    if (directory !== undefined) query.set('directory', directory);
    return request(`/api/audio/browse?${query}`, audioDirectorySchema, 'GET', undefined, options);
  },
  importSelectedAudio: (path: string, options?: RequestOptions) =>
    request(
      '/api/audio/register-selected',
      z.object({ asset: audioAssetSchema, job: jobSchema }).strict(),
      'POST',
      { path },
      { ...options, timeoutMs: options?.timeoutMs ?? IMPORT_TIMEOUT_MS },
    ),
  importAudio: (path: string) =>
    request(
      '/api/audio/register',
      z.object({ asset: audioAssetSchema, job: jobSchema }),
      'POST',
      { path },
      { timeoutMs: IMPORT_TIMEOUT_MS },
    ),
  prepareAudio: (id: string) => request(`/api/audio/${id}/prepare`, z.object({ job: jobSchema }), 'POST', {}),
  relinkAudio: (id: string, path: string) =>
    request(`/api/audio/${id}/relink`, z.object({ job: jobSchema }), 'POST', { path }),
  exportPreflight: (document: ProjectDocument, profile: ExportProfile, options?: RequestOptions) =>
    request(
      '/api/exports/preflight',
      z.object({ space: exportPreflightSchema }).strict(),
      'POST',
      { document, profile },
      { ...options, readOnly: true },
    ),
  export: (document: ProjectDocument, profile: ExportProfile, outputName: string) =>
    request('/api/exports', z.object({ job: jobSchema }), 'POST', { document, profile, outputName }),
  reference: (document: ProjectDocument) =>
    request('/api/reference', z.object({ job: jobSchema }), 'POST', { document }),
};
