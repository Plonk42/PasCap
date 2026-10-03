import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { ZodError } from 'zod';
import { createProject, frameSchema, idSchema, projectSchema, type ProjectDocument } from '../shared/model.js';
import { projectSummarySchema, type ProjectSummary } from '../shared/projects.js';
import { calculateLayout } from '../shared/timeline.js';
import { errorMessage, isNotFound, ServiceError } from './errors.js';
import { assertNoSymlinks } from './files.js';

const MAX_PROJECT_BYTES = 16 * 1024 * 1024;

/** Check existing ancestors before mkdir, so a symlink cannot redirect new output. */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    if (!(await assertNoSymlinks(directory)).isDirectory()) throw new ServiceError('The cache path must be a directory.', 422);
  } catch (error) { if (!isNotFound(error)) throw error; }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await assertNoSymlinks(directory)).isDirectory()) throw new ServiceError('The cache path must be a directory.', 422);
}

export async function atomicWrite(filename: string, contents: string): Promise<void> {
  await ensurePrivateDirectory(path.dirname(filename));
  try {
    if (!(await assertNoSymlinks(filename)).isFile()) throw new ServiceError('Only regular cache files can be replaced.', 422);
  } catch (error) { if (!isNotFound(error)) throw error; }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(contents, 'utf8'); await file.sync(); } finally { await file.close(); }
    await rename(temporary, filename);
    const directory = await open(path.dirname(filename), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}

export class SerialWriter {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result;
    return result;
  }
}

export class ProjectStore {
  readonly #writer = new SerialWriter();
  constructor(private readonly dataDir: string) { }
  private filename(id: string): string { return path.join(this.dataDir, 'projects', `${idSchema.parse(id)}.json`); }
  private async read(filename: string): Promise<{ value: unknown; updatedAt: string }> {
    const info = await assertNoSymlinks(filename);
    if (!info.isFile()) throw new ServiceError('A project must be a regular file.', 422);
    if (info.size > MAX_PROJECT_BYTES) throw new ServiceError('This project exceeds the 16 MiB safety limit.', 422);
    return { value: JSON.parse(await readFile(filename, 'utf8')) as unknown, updatedAt: info.mtime.toISOString() };
  }
  private decode(id: string, value: unknown): ProjectDocument {
    if (typeof value !== 'object' || value === null || !('schemaVersion' in value) || value.schemaVersion !== 5) {
      const rawVersion = typeof value === 'object' && value !== null && 'schemaVersion' in value ? value.schemaVersion : undefined;
      const version = typeof rawVersion === 'string' || typeof rawVersion === 'number' ? String(rawVersion) : 'missing or invalid';
      throw new ServiceError(`Unsupported project schema version ${version}; this build requires version 5 with project-specific media libraries and shared project-frame layer points. No migration is performed.`, 422);
    }
    const document = projectSchema.parse(value);
    if (document.id !== id) throw new ServiceError('The project ID does not match its filename.', 422);
    return document;
  }
  private incompatible(error: unknown): ServiceError {
    const message = error instanceof ZodError ? error.issues.slice(0, 6).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : errorMessage(error);
    return new ServiceError(`Cannot open this project: ${message} Restore a valid version 5 project, open it with a compatible PasCap version, or create a new project. The existing file was not changed.`, 422);
  }
  async load(id: string): Promise<ProjectDocument> {
    const filename = this.filename(id);
    try { return this.decode(id, (await this.read(filename)).value); }
    catch (error) {
      if (isNotFound(error)) throw new ServiceError('Project not found.', 404);
      throw this.incompatible(error);
    }
  }
  async list(): Promise<ProjectSummary[]> {
    return this.#writer.run(async () => {
      const directory = path.join(this.dataDir, 'projects');
      let names: string[];
      try {
        if (!(await assertNoSymlinks(directory)).isDirectory()) throw new ServiceError('The project store must be a directory.', 422);
        names = await readdir(directory);
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }
      const summaries: ProjectSummary[] = [];
      // Bound memory by reading one document at a time, including corrupt files.
      await names.filter((entry) => entry.endsWith('.json')).reduce(async (previous, name) => {
        await previous;
        const filename = path.join(directory, name);
        const parsedId = idSchema.safeParse(name.slice(0, -5));
        const id = parsedId.success ? parsedId.data : `invalid-${createHash('sha256').update(name).digest('hex').slice(0, 32)}`;
        let updatedAt = new Date(0).toISOString();
        let title = name.slice(0, -5);
        try {
          updatedAt = (await lstat(filename)).mtime.toISOString();
          if (!parsedId.success) throw new ServiceError(`Invalid project filename ${JSON.stringify(name)}. Use an ID containing only letters, digits, underscores or hyphens.`, 422);
          const saved = await this.read(filename);
          const value = saved.value;
          if (typeof value === 'object' && value !== null && 'title' in value && typeof value.title === 'string') title = value.title;
          const document = this.decode(id, value);
          summaries.push(projectSummarySchema.parse({ id, title: document.title, revision: document.revision, clipCount: document.clips.length, duration: calculateLayout(document).duration, updatedAt: saved.updatedAt, compatible: true, error: null }));
        } catch (error) {
          // Invalid entries are display-only; never fill in or rewrite a document.
          summaries.push(projectSummarySchema.parse({ id, title, revision: 0, clipCount: 0, duration: 0, updatedAt, compatible: false, error: this.incompatible(error).message }));
        }
      }, Promise.resolve());
      return summaries.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id));
    });
  }
  async create(title: string): Promise<ProjectDocument> {
    return this.save(createProject(randomUUID(), title), 0);
  }
  async delete(id: string, expectedRevision: number | null): Promise<void> {
    const filename = this.filename(id);
    if (expectedRevision !== null) frameSchema.parse(expectedRevision);
    return this.#writer.run(async () => {
      try {
        const info = await assertNoSymlinks(filename);
        if (!info.isFile()) throw new ServiceError('Only regular project files can be deleted.', 422);
        if (expectedRevision === null) {
          // Unavailable files can be explicitly removed without interpreting or migrating them.
          // A now-compatible document still requires a revision, so a stale list cannot delete it.
          let compatible = false;
          try { await this.load(id); compatible = true; }
          catch (error) { if (!(error instanceof ServiceError && error.statusCode === 422)) throw error; }
          if (compatible) throw new ServiceError('This project is now compatible. Refresh Projects before deleting it.', 409);
        } else if ((await this.load(id)).revision !== expectedRevision) {
          throw new ServiceError('This project changed in another tab. Refresh Projects before deleting it.', 409);
        }
        await rm(filename);
        const directory = await open(path.dirname(filename), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) {
        if (isNotFound(error)) throw new ServiceError('Project not found. Refresh Projects to update the list.', 404);
        throw error;
      }
    });
  }
  async rename(id: string, title: string, expectedRevision: number): Promise<ProjectDocument> {
    this.filename(id);
    frameSchema.parse(expectedRevision);
    return this.#writer.run(async () => {
      const current = await this.load(id);
      return this.write(projectSchema.parse({ ...current, title }), expectedRevision);
    });
  }
  async save(document: ProjectDocument, expectedRevision: number): Promise<ProjectDocument> {
    const snapshot = projectSchema.parse(document);
    this.filename(snapshot.id);
    frameSchema.parse(expectedRevision);
    if (snapshot.revision !== expectedRevision) throw new ServiceError('Document and expected revisions must agree.', 409);
    return this.#writer.run(() => this.write(snapshot, expectedRevision));
  }
  private async write(snapshot: ProjectDocument, expectedRevision: number): Promise<ProjectDocument> {
    let current: ProjectDocument | null = null;
    try { current = await this.load(snapshot.id); }
    catch (error) { if (!(error instanceof ServiceError && error.statusCode === 404)) throw error; }
    if ((current?.revision ?? 0) !== expectedRevision) throw new ServiceError('Stale save: this project was saved by another tab. Reload before editing.', 409);
    const saved = projectSchema.parse({ ...snapshot, revision: expectedRevision + 1 });
    await atomicWrite(this.filename(saved.id), `${JSON.stringify(saved, null, 2)}\n`);
    return saved;
  }
}