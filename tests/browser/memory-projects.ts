import type { Page } from '@playwright/test';
import { createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { calculateLayout } from '../../src/shared/timeline.js';

export interface MemoryProjects {
    snapshot: (id?: string) => ProjectDocument;
    /** Replace a fixture before reload, without a request or a history entry. */
    seed: (document: ProjectDocument) => void;
    readonly saves: number;
}

/** Strict schema-6 project CRUD and optimistic revisions, never the on-disk project store. */
export async function memoryProjects(page: Page, initial: ProjectDocument): Promise<MemoryProjects> {
    const documents = new Map([[initial.id, projectSchema.parse(initial)]]);
    let saves = 0;
    let serial = 0;
    await page.route(/\/api\/projects(?:\?.*)?$/, async (route) => {
        const method = route.request().method();
        if (method === 'GET') {
            await route.fulfill({
                json: {
                    projects: [...documents.values()].map((document) => ({
                        id: document.id, title: document.title, revision: document.revision,
                        clipCount: document.clips.length, duration: calculateLayout(document).duration,
                        updatedAt: '2026-10-03T10:00:00Z', compatible: true, error: null,
                    }))
                }
            });
            return;
        }
        if (method === 'POST') {
            const body = route.request().postDataJSON() as { title: string };
            let id: string;
            do { id = `browser-project-${++serial}`; } while (documents.has(id));
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
        const saved = documents.get(id);
        if (!saved) { await route.fulfill({ status: 404, json: { error: 'Memory-only project not found.' } }); return; }
        if (method === 'GET') { await route.fulfill({ json: { document: saved } }); return; }
        if (method === 'DELETE') {
            const body = route.request().postDataJSON() as { expectedRevision: number | null };
            if (body.expectedRevision !== saved.revision) {
                await route.fulfill({ status: 409, json: { error: 'The memory-only project revision changed.' } }); return;
            }
            documents.delete(id);
            await route.fulfill({ json: { deleted: true } }); return;
        }
        if (method === 'PUT') {
            const body = route.request().postDataJSON() as { document: unknown; expectedRevision: number };
            if (body.expectedRevision !== saved.revision) {
                await route.fulfill({ status: 409, json: { error: 'The memory-only project revision changed.' } });
                return;
            }
            const parsed = projectSchema.parse(body.document);
            if (parsed.id !== id) { await route.fulfill({ status: 400, json: { error: 'Project identity changed.' } }); return; }
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
        seed: (document) => { documents.set(document.id, projectSchema.parse(document)); },
        get saves() { return saves; },
    };
}