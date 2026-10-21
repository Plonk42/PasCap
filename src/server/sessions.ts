import { randomBytes } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  checkpointSummarySchema,
  MAX_SESSION_EDITS,
  sessionSchema,
  type AssistantSession,
  type Brief,
  type CheckpointSummary,
} from '../shared/assistant-session.js';
import { idSchema, type ProjectDocument } from '../shared/model.js';
import { forEachSerial } from '../shared/serial.js';
import type { AssistantSessionLimits } from './config.js';
import { isNotFound, ServiceError } from './errors.js';
import { assertNoSymlinks } from './files.js';
import { atomicWrite, SerialWriter, type ProjectStore, type ProjectWriter } from './storage.js';

const CHECKPOINT_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/;
const MAX_CHECKPOINT_BYTES = 17 * 1024 * 1024;
const checkpointFileSchema = z.object({ summary: checkpointSummarySchema, document: z.unknown() }).strict();

export type SessionStarter = 'user' | 'assistant';

/**
 * Assistant sessions and checkpoints, stored beside the projects in `<dataDir>/assistant/<id>/`,
 * outside the project document. An active session holds the project's write lease: the user's
 * writes are refused (423) and only the assistant may write, until the user takes over, the
 * assistant finishes or the lease expires.
 */
export class AssistantSessions {
  readonly #writer = new SerialWriter();
  /** Checkpoint IDs sort by time, so two are never taken in the same millisecond. */
  #lastCheckpoint = 0;
  constructor(
    private readonly dataDir: string,
    private readonly limits: AssistantSessionLimits,
    private readonly projects: ProjectStore,
    private readonly clock: () => number = Date.now,
  ) {
    projects.guardWrites((projectId, writer) => this.#guard(projectId, writer));
  }

  private directory(projectId: string): string {
    return path.join(this.dataDir, 'assistant', idSchema.parse(projectId));
  }
  private sessionFile(projectId: string): string {
    return path.join(this.directory(projectId), 'session.json');
  }
  private now(): string {
    return new Date(this.clock()).toISOString();
  }

  private async read(projectId: string): Promise<AssistantSession | null> {
    const filename = this.sessionFile(projectId);
    try {
      if (!(await assertNoSymlinks(filename)).isFile())
        throw new ServiceError('A session must be a regular file.', 500);
      return sessionSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
  private async write(session: AssistantSession): Promise<AssistantSession> {
    await atomicWrite(
      this.sessionFile(session.projectId),
      `${JSON.stringify(sessionSchema.parse(session), null, 2)}\n`,
    );
    return session;
  }

  /** The project's latest session; an active one idle past the lease is ended as expired. */
  current(projectId: string): Promise<AssistantSession | null> {
    return this.#writer.run(() => this.#current(projectId));
  }
  async #current(projectId: string): Promise<AssistantSession | null> {
    const session = await this.read(projectId);
    if (session?.endedAt !== null) return session;
    const expiry = Date.parse(session.lastActivityAt) + this.limits.leaseMs;
    if (this.clock() < expiry) return session;
    return this.write({ ...session, endedAt: new Date(expiry).toISOString(), endedBy: 'expiry' });
  }
  expiresAt(session: AssistantSession): string | null {
    return session.endedAt === null
      ? new Date(Date.parse(session.lastActivityAt) + this.limits.leaseMs).toISOString()
      : null;
  }

  async #guard(projectId: string, writer: ProjectWriter): Promise<void> {
    const session = await this.current(projectId);
    const active = session !== null && session.endedAt === null;
    if (writer === 'user') {
      if (active)
        throw new ServiceError(
          'An assistant is editing this project. Take over in the editor to edit it again; nothing was saved.',
          423,
        );
      return;
    }
    if (!active) throw new ServiceError(this.#inactiveReason(session), 409);
    await this.touch(projectId);
  }
  #inactiveReason(session: AssistantSession | null): string {
    const restart = 'Start a new session with session_start to edit it again.';
    if (session === null) return 'Start an assistant session with session_start before editing this project.';
    if (session.endedBy === 'user') return `The user took the project back. ${restart}`;
    if (session.endedBy === 'expiry')
      return `The assistant session ended after ${this.limits.leaseMs / 60_000} minutes without activity. ${restart}`;
    return `The assistant session has ended. ${restart}`;
  }

  /** Keeps an active session's lease alive; does nothing without one. */
  touch(projectId: string): Promise<void> {
    return this.#writer.run(async () => {
      const session = await this.#current(projectId);
      if (session?.endedAt === null) await this.write({ ...session, lastActivityAt: this.now() });
    });
  }

  /** Checkpoints the project and takes its write lease, against the revision the starter last read. */
  start(
    projectId: string,
    expectedRevision: number,
    brief: Brief,
    startedBy: SessionStarter,
  ): Promise<AssistantSession> {
    return this.projects.exclusive(async () => {
      const document = await this.projects.load(projectId);
      if (document.revision !== expectedRevision)
        throw new ServiceError(
          `The project is at revision ${document.revision}, not ${expectedRevision}: read it again (in the editor, wait until it is saved) before starting a session.`,
          409,
        );
      const previous = await this.current(projectId);
      if (previous?.endedAt === null)
        throw new ServiceError(
          `An assistant session has been active on this project since ${previous.startedAt}.`,
          409,
        );
      const checkpoint = await this.#checkpoint(document, 'session-start', null, null);
      const now = this.now();
      return this.#writer.run(() =>
        this.write({
          projectId,
          startedAt: now,
          startedBy,
          lastActivityAt: now,
          brief,
          checkpointId: checkpoint.id,
          edits: [],
          endedAt: null,
          endedBy: null,
          notes: null,
        }),
      );
    });
  }

  /** Ends the active session: the user takes over, or the assistant finishes with notes. */
  end(projectId: string, by: 'user' | 'assistant', notes: string | null): Promise<AssistantSession | null> {
    return this.#writer.run(async () => {
      const session = await this.#current(projectId);
      if (session?.endedAt !== null) {
        if (by === 'assistant') throw new ServiceError(this.#inactiveReason(session), 409);
        return session;
      }
      return this.write({ ...session, endedAt: this.now(), endedBy: by, notes, lastActivityAt: this.now() });
    });
  }

  recordEdit(projectId: string, revision: number, types: readonly string[]): Promise<void> {
    return this.#writer.run(async () => {
      const session = await this.#current(projectId);
      if (session?.endedAt !== null) return;
      const at = this.now();
      const edit = { revision, at, commands: types.length, summary: types.join(', ') };
      await this.write({ ...session, lastActivityAt: at, edits: [...session.edits, edit].slice(-MAX_SESSION_EDITS) });
    });
  }

  private checkpointFile(projectId: string, checkpointId: string): string {
    if (!CHECKPOINT_ID.test(checkpointId)) throw new ServiceError('Unknown checkpoint.', 404);
    return path.join(this.directory(projectId), 'checkpoints', `${checkpointId}.json`);
  }

  async #checkpoint(
    document: ProjectDocument,
    reason: CheckpointSummary['reason'],
    label: string | null,
    keep: string | null,
  ): Promise<CheckpointSummary> {
    this.#lastCheckpoint = Math.max(this.clock(), this.#lastCheckpoint + 1);
    const createdAt = new Date(this.#lastCheckpoint).toISOString();
    const id = `${createdAt.replaceAll(':', '-').replace('.', '-')}-${randomBytes(3).toString('hex')}`;
    const summary = { id, createdAt, reason, label, revision: document.revision, title: document.title };
    await atomicWrite(this.checkpointFile(document.id, id), `${JSON.stringify({ summary, document })}\n`);
    const session = await this.current(document.id);
    const kept = new Set([id, keep, session?.endedAt === null ? session.checkpointId : null]);
    // Newest first: the oldest unprotected checkpoints go once there are too many.
    const all = await this.checkpoints(document.id);
    const removable = all.filter((checkpoint) => !kept.has(checkpoint.id));
    const excess = all.length - this.limits.checkpoints;
    await forEachSerial(excess > 0 ? removable.slice(-excess) : [], (checkpoint) =>
      rm(this.checkpointFile(document.id, checkpoint.id), { force: true }),
    );
    return summary;
  }

  /** A checkpoint of the project as it is saved now. */
  checkpoint(projectId: string, label: string | null): Promise<CheckpointSummary> {
    return this.projects.exclusive(async () =>
      this.#checkpoint(await this.projects.load(projectId), 'manual', label, null),
    );
  }

  /** The project's checkpoints, newest first. */
  async checkpoints(projectId: string): Promise<CheckpointSummary[]> {
    const directory = path.join(this.directory(projectId), 'checkpoints');
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const summaries: CheckpointSummary[] = [];
    await forEachSerial(
      names.filter((entry) => CHECKPOINT_ID.test(entry.replace(/\.json$/, ''))),
      async (name) => {
        summaries.push((await this.#readCheckpoint(projectId, name.replace(/\.json$/, ''))).summary);
      },
    );
    return summaries.sort((left, right) => right.id.localeCompare(left.id));
  }

  async #readCheckpoint(projectId: string, checkpointId: string) {
    const filename = this.checkpointFile(projectId, checkpointId);
    try {
      const info = await assertNoSymlinks(filename);
      if (!info.isFile() || info.size > MAX_CHECKPOINT_BYTES) throw new ServiceError('Invalid checkpoint file.', 422);
      return checkpointFileSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
    } catch (error) {
      if (isNotFound(error)) throw new ServiceError('Unknown checkpoint.', 404);
      throw error;
    }
  }

  /** Replaces the project with a checkpoint in one revision, after checkpointing its current state. */
  restore(
    projectId: string,
    checkpointId: string,
    expectedRevision: number,
    writer: ProjectWriter,
    assertSources: (document: ProjectDocument) => Promise<void>,
  ): Promise<ProjectDocument> {
    return this.projects.exclusive(async () => {
      const current = await this.projects.load(projectId);
      if (current.revision !== expectedRevision)
        throw new ServiceError(
          `The project is at revision ${current.revision}, not ${expectedRevision}: read it again before restoring.`,
          409,
        );
      const { summary, document } = await this.#readCheckpoint(projectId, checkpointId);
      const restored = this.projects.revive(projectId, document);
      await assertSources(restored);
      await this.#checkpoint(current, 'before-restore', `Before restoring ${summary.createdAt}`, checkpointId);
      return this.projects.writeExclusive({ ...restored, revision: current.revision }, current.revision, writer);
    });
  }

  /** Saves a checkpoint as a new project, leaving the project it belongs to unchanged. */
  async copy(
    projectId: string,
    checkpointId: string,
    title: string,
    assertSources: (document: ProjectDocument) => Promise<void>,
  ): Promise<ProjectDocument> {
    const { document } = await this.#readCheckpoint(projectId, checkpointId);
    const copy = this.projects.decodeFile(document);
    const titled = { ...copy, title };
    await assertSources(titled);
    return this.projects.save(titled, 0);
  }
}
