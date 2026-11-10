import type { Page } from '@playwright/test';
import type { Brief, CheckpointSummary } from '../../src/shared/assistant-session.js';
import { createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import type { OperationOutput } from '../../src/shared/operations/index.js';
import { calculateLayout } from '../../src/shared/timeline.js';

export interface MemoryProjects {
  snapshot: (id?: string) => ProjectDocument;
  /** Replace a fixture before reload, without a request or a history entry. */
  seed: (document: ProjectDocument) => void;
  /** The assistant session session_status reports, null for none; Take over and restore update it. */
  session: MemorySession | null;
  /** What hand_off_readiness reports. */
  readiness: OperationOutput<'hand_off_readiness'>;
  /** The checkpoints the user took or a restore made, newest first. */
  readonly checkpoints: readonly { summary: CheckpointSummary; document: ProjectDocument }[];
  readonly saves: number;
}

export interface MemorySession {
  view: OperationOutput<'session_status'>['session'];
  /** The project as it was when the session started, for checkpoint_restore. */
  checkpoint: ProjectDocument;
}

/** A session the editor's Hand off started, as session_start reports it. */
function startedSession(projectId: string, brief: Brief): NonNullable<MemorySession['view']> {
  return {
    projectId,
    startedAt: '2026-10-21T10:00:00.000Z',
    startedBy: 'user',
    lastActivityAt: '2026-10-21T10:00:00.000Z',
    brief,
    checkpointId: '2026-10-21T10-00-00-000Z-memory',
    edits: [],
    endedAt: null,
    endedBy: null,
    notes: null,
    active: true,
    expiresAt: '2026-10-21T10:10:00.000Z',
  };
}

/** Strict current-schema project CRUD and optimistic revisions, never the on-disk project store. */
export async function memoryProjects(page: Page, initial: ProjectDocument): Promise<MemoryProjects> {
  const documents = new Map([[initial.id, projectSchema.parse(initial)]]);
  let saves = 0;
  let serial = 0;
  let session: MemorySession | null = null;
  const checkpoints: { summary: CheckpointSummary; document: ProjectDocument }[] = [];
  const keep = (
    document: ProjectDocument,
    reason: CheckpointSummary['reason'],
    label: string | null,
  ): CheckpointSummary => {
    // As the service does, an existing checkpoint of the same content (revision aside) is reused.
    const content = (item: ProjectDocument): string => JSON.stringify({ ...item, revision: 0 });
    const existing = checkpoints.find((entry) => content(entry.document) === content(document));
    if (existing) return existing.summary;
    const id = `2026-10-22T10-00-${String(checkpoints.length).padStart(2, '0')}-000Z-memory`;
    const summary = {
      id,
      createdAt: `2026-10-22T10:00:${String(checkpoints.length).padStart(2, '0')}.000Z`,
      reason,
      label,
      revision: document.revision,
      title: document.title,
    };
    checkpoints.unshift({ summary, document });
    return summary;
  };
  const stored = (checkpointId: string): ProjectDocument | undefined =>
    checkpoints.find((entry) => entry.summary.id === checkpointId)?.document ??
    (session?.view?.checkpointId === checkpointId ? session.checkpoint : undefined);
  const checkpointReply = (
    name: string,
    body: { label?: string | null; checkpointId?: string; title?: string; expectedRevision?: number },
    saved: ProjectDocument,
  ): { status?: number; json: unknown } | null => {
    if (name === 'checkpoint') return { json: keep(saved, 'manual', body.label ?? null) };
    if (name !== 'checkpoint_copy' && name !== 'checkpoint_restore') return null;
    if (name === 'checkpoint_restore' && session?.view?.active)
      return {
        status: 423,
        json: { error: 'An assistant is editing this project. Take over in the editor to edit it again.' },
      };
    const source = stored(body.checkpointId!);
    if (!source) return { status: 404, json: { error: 'Unknown checkpoint.' } };
    if (name === 'checkpoint_copy') {
      const copy = projectSchema.parse({
        ...source,
        id: `browser-project-${++serial}`,
        title: body.title,
        revision: 1,
      });
      documents.set(copy.id, copy);
      return { json: { projectId: copy.id, title: copy.title } };
    }
    if (body.expectedRevision !== saved.revision)
      return { status: 409, json: { error: 'The memory-only project revision changed.' } };
    keep(saved, 'before-restore', 'Before restoring');
    const restored = projectSchema.parse({ ...source, revision: saved.revision + 1 });
    documents.set(restored.id, restored);
    return {
      json: {
        revision: restored.revision,
        duration: { frames: calculateLayout(restored).duration, seconds: 0, timecode: '00:00:00' },
      },
    };
  };
  let readiness: OperationOutput<'hand_off_readiness'> = {
    recordings: [],
    music: [],
    exportRunning: false,
    connection: { url: 'http://127.0.0.1:4318/mcp', tokenFile: '/data/mcp-token', lastCall: null, client: null },
  };
  // The waveform of a placed synthetic music fixture is a read of its prepared cache.
  await page.route('**/api/ops/music_waveform', (route) => route.continue());
  // No style is registered: Auto and Hand off offer the generic look only.
  await page.route('**/api/ops/list_styles', (route) => route.fulfill({ json: { styles: [] } }));
  await page.route(
    /\/api\/ops\/(session_status|session_start|session_end|checkpoint|checkpoint_restore|checkpoint_copy|hand_off_readiness)$/,
    async (route) => {
      const name = new URL(route.request().url()).pathname.slice('/api/ops/'.length);
      const body = route.request().postDataJSON() as {
        projectId: string;
        expectedRevision?: number;
        brief?: Brief;
        title?: string;
        label?: string | null;
        checkpointId?: string;
        checkpoints?: boolean;
      };
      const saved = documents.get(body.projectId);
      if (!saved) {
        await route.fulfill({ status: 404, json: { error: 'Memory-only project not found.' } });
        return;
      }
      if (name === 'hand_off_readiness') {
        await route.fulfill({ json: readiness });
        return;
      }
      if (name === 'session_start') {
        if (session?.view?.active || body.expectedRevision !== saved.revision) {
          await route.fulfill({ status: 409, json: { error: 'The memory-only session cannot start.' } });
          return;
        }
        session = { checkpoint: saved, view: startedSession(saved.id, body.brief!) };
        await route.fulfill({ json: session.view });
        return;
      }
      const reply = checkpointReply(name, body, saved);
      if (reply) {
        await route.fulfill(reply);
        return;
      }
      if (name === 'session_end' && session?.view?.active) {
        session.view = {
          ...session.view,
          active: false,
          endedAt: '2026-10-21T10:05:00.000Z',
          endedBy: 'user',
          expiresAt: null,
        };
      }
      if (name === 'session_end') {
        await route.fulfill({ json: { session: session?.view ?? null } });
        return;
      }
      const view = session?.view?.projectId === body.projectId ? session.view : null;
      await route.fulfill({
        json: {
          session: view,
          revision: saved.revision,
          checkpoints: body.checkpoints === false ? [] : checkpoints.map((entry) => entry.summary),
        },
      });
    },
  );
  await page.route(/\/api\/projects(?:\?.*)?$/, async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({
        json: {
          projects: [...documents.values()].map((document) => ({
            id: document.id,
            title: document.title,
            revision: document.revision,
            clipCount: document.clips.length,
            duration: calculateLayout(document).duration,
            updatedAt: '2026-10-03T10:00:00Z',
            compatible: true,
            error: null,
          })),
        },
      });
      return;
    }
    if (method === 'POST') {
      const body = route.request().postDataJSON() as { title: string };
      let id: string;
      do {
        id = `browser-project-${++serial}`;
      } while (documents.has(id));
      const document = { ...createProject(id, body.title), revision: 1 };
      documents.set(id, document);
      await route.fulfill({ status: 201, json: { document } });
      return;
    }
    await route.abort('blockedbyclient');
  });
  await page.route(/\/api\/projects\/[^/?]+(?:\?.*)?$/, async (route) => {
    const id = new URL(route.request().url()).pathname.slice('/api/projects/'.length);
    const method = route.request().method();
    if (id === 'import' && method === 'POST') {
      const body = route.request().postDataJSON() as { document: unknown };
      const parsed = projectSchema.safeParse(body.document);
      if (!parsed.success) {
        await route.fulfill({ status: 422, json: { error: 'This is not a PasCap project file this build can open.' } });
        return;
      }
      const copy = projectSchema.parse({ ...parsed.data, id: `browser-project-${++serial}`, revision: 1 });
      documents.set(copy.id, copy);
      await route.fulfill({ status: 201, json: { document: copy } });
      return;
    }
    const saved = documents.get(id);
    if (!saved) {
      await route.fulfill({ status: 404, json: { error: 'Memory-only project not found.' } });
      return;
    }
    if (method === 'GET') {
      await route.fulfill({ json: { document: saved } });
      return;
    }
    if (method === 'DELETE') {
      const body = route.request().postDataJSON() as { expectedRevision: number | null };
      if (body.expectedRevision !== saved.revision) {
        await route.fulfill({ status: 409, json: { error: 'The memory-only project revision changed.' } });
        return;
      }
      documents.delete(id);
      await route.fulfill({ json: { deleted: true } });
      return;
    }
    if (method === 'PUT') {
      const body = route.request().postDataJSON() as { document: unknown; expectedRevision: number };
      if (body.expectedRevision !== saved.revision) {
        await route.fulfill({ status: 409, json: { error: 'The memory-only project revision changed.' } });
        return;
      }
      const parsed = projectSchema.parse(body.document);
      if (parsed.id !== id) {
        await route.fulfill({ status: 400, json: { error: 'Project identity changed.' } });
        return;
      }
      const document = projectSchema.parse({ ...parsed, revision: saved.revision + 1 });
      documents.set(id, document);
      saves++;
      await route.fulfill({ json: { document } });
      return;
    }
    await route.abort('blockedbyclient');
  });
  return {
    snapshot: (id = initial.id) => {
      const document = documents.get(id);
      if (!document) throw new Error(`Unknown memory-only project ${id}.`);
      return projectSchema.parse(document);
    },
    seed: (document) => {
      documents.set(document.id, projectSchema.parse(document));
    },
    get session() {
      return session;
    },
    set session(next) {
      session = next;
    },
    get readiness() {
      return readiness;
    },
    set readiness(next) {
      readiness = next;
    },
    checkpoints,
    get saves() {
      return saves;
    },
  };
}
