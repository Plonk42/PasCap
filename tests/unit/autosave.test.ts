import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, type ProjectDocument } from '../../src/shared/model.js';
import { api, ApiError } from '../../src/web/api.js';
import { Autosave, type SaveState } from '../../src/web/autosave.js';

type Save = (document: ProjectDocument, revision: number) => Promise<ProjectDocument>;
const autosaves: Autosave[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
function setup(save: Save, project = createProject('flight', 'Original')) {
  const states: SaveState[] = [];
  const autosave = new Autosave(project, save, (state) => states.push(state));
  autosaves.push(autosave);
  return { project, autosave, states };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  autosaves.splice(0).forEach((autosave) => autosave.dispose());
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('serial autosave', () => {
  it('does not save or emit state for a clean document', async () => {
    const save = vi.fn<Save>();
    const { autosave, states } = setup(save, { ...createProject('flight', 'Original'), revision: 8 });
    await autosave.flush(); await autosave.retry();
    expect(save).not.toHaveBeenCalled(); expect(states).toEqual([]);
    expect(autosave.dirty).toBe(false); expect(autosave.revision).toBe(8);
  });

  it('debounces the latest edit for 600 milliseconds and clears its timer after success', async () => {
    const save = vi.fn<Save>(async (snapshot, revision) => ({ ...snapshot, revision: revision + 1 }));
    const { project, autosave, states } = setup(save);
    autosave.update({ ...project, title: 'First' });
    await vi.advanceTimersByTimeAsync(599);
    expect(save).not.toHaveBeenCalled();
    autosave.update({ ...project, title: 'Latest' });
    await vi.advanceTimersByTimeAsync(599);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1); expect(save.mock.calls[0]?.[0].title).toBe('Latest');
    expect(states.at(-1)).toEqual({ state: 'saved', message: 'Saved on this device', revision: 1, recovery: null });
    expect(autosave.dirty).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not lose changes made while an earlier revision is saving', async () => {
    const gate = deferred<void>();
    const revisions: number[] = [];
    const save = vi.fn<Save>(async (snapshot, revision) => { revisions.push(revision); if (revision === 0) await gate.promise; return { ...snapshot, revision: revision + 1 }; });
    const { project, autosave, states } = setup(save);
    autosave.update({ ...project, title: 'First' }); const pending = autosave.flush();
    autosave.update({ ...project, title: 'Second' }); gate.resolve(); await pending;
    expect(save).toHaveBeenCalledTimes(2); expect(revisions).toEqual([0, 1]);
    expect(save.mock.calls[1]?.[0].title).toBe('Second');
    expect(states.filter((state) => state.state === 'saved').map((state) => state.revision)).toEqual([2]);
    expect(autosave.dirty).toBe(false); expect(states.at(-1)?.revision).toBe(2);
  });

  it('serializes concurrent flush calls and debounce expiry, taking only the latest queued draft', async () => {
    const gate = deferred<void>(); let active = 0; let maximumActive = 0;
    const save = vi.fn<Save>(async (snapshot, revision) => {
      active++; maximumActive = Math.max(maximumActive, active);
      if (revision === 5) await gate.promise;
      active--; return { ...snapshot, revision: revision + 1 };
    });
    const { project, autosave, states } = setup(save, { ...createProject('flight', 'Original'), revision: 5 });
    autosave.update({ ...project, title: 'First' });
    const pending = Promise.all([autosave.flush(), autosave.flush(), autosave.flush()]);
    await vi.advanceTimersByTimeAsync(0);
    autosave.update({ ...project, title: 'Intermediate' }); autosave.update({ ...project, title: 'Latest' });
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1); expect(autosave.dirty).toBe(true);
    gate.resolve(); await pending;
    expect(maximumActive).toBe(1);
    expect(save.mock.calls.map(([snapshot, revision]) => [snapshot.title, snapshot.revision, revision])).toEqual([['First', 5, 5], ['Latest', 6, 6]]);
    expect(states.filter((state) => state.state === 'saved').map((state) => state.revision)).toEqual([7]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clones drafts and uses the confirmed revision rather than stale editor revisions', async () => {
    const save = vi.fn<Save>(async (snapshot, revision) => ({ ...snapshot, revision: revision + 1 }));
    const { project, autosave } = setup(save, { ...createProject('flight', 'Original'), revision: 4 });
    const edited = { ...project, title: 'Edited', revision: 0, layers: project.layers.map((layer) => ({ ...layer })) };
    autosave.update(edited);
    edited.title = 'Outside mutation'; edited.layers[0]!.name = 'Outside layer mutation';
    await autosave.flush();
    expect(save.mock.calls[0]?.[0]).toMatchObject({ title: 'Edited', revision: 4, layers: [{ name: 'Video 1' }] });
    expect(save.mock.calls[0]?.[1]).toBe(4); expect(autosave.revision).toBe(5);
  });

  it('does not duplicate a save when a state listener synchronously calls flush', async () => {
    const project = createProject('flight', 'Original'); const states: SaveState[] = [];
    const save = vi.fn<Save>(async (snapshot, revision) => ({ ...snapshot, revision: revision + 1 }));
    let reentrant: Promise<void> | null = null;
    const autosave = new Autosave(project, save, (state) => {
      states.push(state);
      if (state.state === 'saving' && reentrant === null) reentrant = autosave.flush();
    });
    autosaves.push(autosave);
    autosave.update({ ...project, title: 'Edited' }); await autosave.flush(); await reentrant;
    expect(save).toHaveBeenCalledTimes(1); expect(states.at(-1)?.state).toBe('saved');
  });

  it('does not leave a debounce timer when an unsaved-state listener immediately flushes', async () => {
    const project = createProject('flight', 'Original');
    const save = vi.fn<Save>(async (snapshot, revision) => ({ ...snapshot, revision: revision + 1 }));
    let pending: Promise<void> | null = null;
    const autosave = new Autosave(project, save, (state) => { if (state.state === 'unsaved') pending = autosave.flush(); });
    autosaves.push(autosave);
    autosave.update({ ...project, title: 'Edited' }); await pending;
    expect(save).toHaveBeenCalledTimes(1); expect(autosave.dirty).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it('retains exactly one debounce timer after a reentrant edit from a state listener', async () => {
    const project = createProject('flight', 'Original'); let editedAgain = false;
    const save = vi.fn<Save>(async (snapshot, revision) => ({ ...snapshot, revision: revision + 1 }));
    const autosave = new Autosave(project, save, (state) => {
      if (state.state === 'unsaved' && !editedAgain) { editedAgain = true; autosave.update({ ...project, title: 'Nested latest edit' }); }
    });
    autosaves.push(autosave);
    autosave.update({ ...project, title: 'First' }); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1); expect(save.mock.calls[0]?.[0].title).toBe('Nested latest edit');
    expect(autosave.dirty).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it('blocks automatic retries after stale/error responses and remains dirty', async () => {
    const save = vi.fn<Save>(async () => { throw new Error('Stale save'); });
    const { project, autosave, states } = setup(save);
    autosave.update({ ...project, title: 'Changed' }); await autosave.flush(); await autosave.flush();
    autosave.update({ ...project, title: 'Later edit' }); await vi.advanceTimersByTimeAsync(6_000); await autosave.retry();
    expect(save).toHaveBeenCalledTimes(1); expect(autosave.dirty).toBe(true);
    expect(states.at(-1)).toEqual({ state: 'error', message: 'Stale save', revision: 0, recovery: null });
  });

  it('captures a synchronous save failure without leaving a stuck pending operation', async () => {
    const save = vi.fn<Save>(() => { throw new ApiError('Service unavailable', 503); });
    const { project, autosave, states } = setup(save);
    autosave.update({ ...project, title: 'Changed' }); await autosave.flush();
    expect(states.at(-1)).toMatchObject({ state: 'error', message: 'Service unavailable', recovery: 'retry' });
    await autosave.retry();
    expect(save).toHaveBeenCalledTimes(2); expect(autosave.dirty).toBe(true);
  });

  it('rejects invalid edits and another project without replacing the last valid draft', async () => {
    const save = vi.fn<Save>(async (snapshot, revision) => ({ ...snapshot, revision: revision + 1 }));
    const { project, autosave } = setup(save);
    autosave.update({ ...project, title: 'Valid draft' });
    expect(() => autosave.update({ ...project, title: '' })).toThrow();
    expect(() => autosave.update(createProject('other-flight', 'Other project'))).toThrow('different project');
    await autosave.flush();
    expect(save.mock.calls[0]?.[0].title).toBe('Valid draft'); expect(autosave.revision).toBe(1);
  });
});

describe('explicit autosave recovery', () => {
  it.each([0, 408, 429, 500, 502, 503, 504])('manually retries transient status %i using the latest draft and original expected revision', async (status) => {
    const message = `Original failure at HTTP ${status}`;
    const save = vi.fn<Save>().mockRejectedValueOnce(new ApiError(message, status))
      .mockImplementation(async (snapshot, revision) => ({ ...snapshot, revision: revision + 1 }));
    const { project, autosave, states } = setup(save, { ...createProject('flight', 'Original'), revision: 4 });
    autosave.update({ ...project, title: 'Failed draft' }); await autosave.flush();
    expect(states.at(-1)).toEqual({ state: 'error', message, revision: 4, recovery: 'retry' });
    autosave.update({ ...project, title: 'Latest draft', revision: 999 });
    await vi.advanceTimersByTimeAsync(6_000); await autosave.flush();
    expect(save).toHaveBeenCalledTimes(1); expect(states.at(-1)?.message).toBe(message);
    await autosave.retry();
    expect(save.mock.calls.map(([snapshot, revision]) => [snapshot.title, snapshot.revision, revision])).toEqual([['Failed draft', 4, 4], ['Latest draft', 4, 4]]);
    expect(autosave.dirty).toBe(false);
    expect(states.at(-1)).toEqual({ state: 'saved', message: 'Saved on this device', revision: 5, recovery: null });
  });

  it.each([400, 401, 403, 404, 409, 413, 422])('does not retry non-transient status %i after edits, flushes or repeated retry calls', async (status) => {
    const error = new ApiError(`Original error ${status}`, status);
    const save = vi.fn<Save>().mockRejectedValue(error);
    const { project, autosave, states } = setup(save, { ...createProject('flight', 'Original'), revision: 7 });
    autosave.update({ ...project, title: 'Changed' }); await autosave.flush();
    autosave.update({ ...project, title: 'Later draft', revision: 100 });
    await autosave.retry(); await autosave.flush(); await autosave.retry(); await vi.advanceTimersByTimeAsync(6_000);
    expect(save).toHaveBeenCalledTimes(1); expect(save.mock.calls[0]?.[1]).toBe(7);
    expect(autosave.revision).toBe(7); expect(autosave.dirty).toBe(true);
    expect(states.at(-1)).toEqual({ state: 'error', message: error.message, revision: 7, recovery: status === 409 ? 'conflict' : null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new ApiError('Cancelled', 0, 'aborted'), new ApiError('Invalid response', 200, 'response'),
    new ApiError('Invalid request', 0, 'request'), new Error('Unclassified error'), 'Original rejected explanation', null,
  ])('does not offer retry for an unclassified, cancelled or invalid response failure', async (error) => {
    const save = vi.fn<Save>().mockRejectedValueOnce(error);
    const { project, autosave, states } = setup(save);
    autosave.update({ ...project, title: 'Edited' }); await autosave.flush();
    const failure = states.at(-1);
    expect(failure).toMatchObject({ state: 'error', recovery: null });
    expect(failure?.message.length).toBeGreaterThan(0);
    autosave.update({ ...project, title: 'Later draft' }); await autosave.retry();
    expect(states.at(-1)).toEqual(failure); expect(save).toHaveBeenCalledTimes(1); expect(autosave.dirty).toBe(true);
  });

  it('keeps a lost successful write blocked when its explicit retry returns a conflict', async () => {
    const project = { ...createProject('flight', 'Original'), revision: 3 };
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('Response lost after commit'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Stale save: this project was saved by another tab. Reload before editing.' }), { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);
    const { autosave, states } = setup(api.save, project);
    autosave.update({ ...project, title: 'Lost acknowledgement' }); await autosave.flush();
    expect(states.at(-1)?.recovery).toBe('retry');
    autosave.update({ ...project, title: 'Latest unsaved draft', revision: 4 }); await autosave.retry();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const retriedBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(firstBody.expectedRevision).toBe(3);
    expect(retriedBody).toMatchObject({ expectedRevision: 3, document: { revision: 3, title: 'Latest unsaved draft' } });
    expect(states.at(-1)).toMatchObject({ state: 'error', recovery: 'conflict', revision: 3, message: expect.stringContaining('another tab') });
    const conflict = states.at(-1);
    autosave.update({ ...project, title: 'Draft after conflict', revision: 50 });
    await autosave.retry(); await autosave.flush(); await vi.advanceTimersByTimeAsync(6_000);
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(states.at(-1)).toEqual(conflict);
    expect(autosave.revision).toBe(3); expect(autosave.dirty).toBe(true);
  });

  it('keeps a newer edit dirty while a manual retry is in flight and saves it serially afterward', async () => {
    const retryGate = deferred<ProjectDocument>(); const latestGate = deferred<ProjectDocument>();
    const save = vi.fn<Save>().mockRejectedValueOnce(new ApiError('Disconnected', 0))
      .mockImplementationOnce(() => retryGate.promise).mockImplementationOnce(() => latestGate.promise);
    const { project, autosave, states } = setup(save);
    autosave.update({ ...project, title: 'Failed draft' }); await autosave.flush();
    autosave.update({ ...project, title: 'Retry draft' });
    const pending = autosave.retry(); await vi.advanceTimersByTimeAsync(0);
    autosave.update({ ...project, title: 'Newest draft' });
    await autosave.retry(); await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(2);
    retryGate.resolve({ ...project, title: 'Retry draft', revision: 1 }); await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(3); expect(autosave.dirty).toBe(true);
    expect(save.mock.calls[2]).toEqual([{ ...project, title: 'Newest draft', revision: 1 }, 1]);
    expect(states.some((state) => state.state === 'saved')).toBe(false);
    latestGate.resolve({ ...project, title: 'Newest draft', revision: 2 }); await pending;
    expect(autosave.dirty).toBe(false); expect(states.at(-1)).toMatchObject({ state: 'saved', revision: 2, recovery: null });
  });

  it('serializes simultaneous manual retries and requires a fresh click after another failure', async () => {
    const gate = deferred<ProjectDocument>();
    const save = vi.fn<Save>().mockRejectedValueOnce(new ApiError('First outage', 503))
      .mockImplementationOnce(() => gate.promise).mockRejectedValueOnce(new ApiError('Still unavailable', 502));
    const { project, autosave, states } = setup(save);
    autosave.update({ ...project, title: 'Draft' }); await autosave.flush();
    const first = autosave.retry(); const duplicate = autosave.retry(); await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    gate.reject(new ApiError('Retry connection lost', 0)); await first; await duplicate;
    expect(states.at(-1)).toMatchObject({ message: 'Retry connection lost', recovery: 'retry' });
    autosave.update({ ...project, title: 'Latest' }); await vi.advanceTimersByTimeAsync(6_000); await autosave.flush();
    expect(save).toHaveBeenCalledTimes(2);
    await autosave.retry();
    expect(save).toHaveBeenCalledTimes(3); expect(states.at(-1)).toMatchObject({ message: 'Still unavailable', recovery: 'retry' });
    expect(autosave.revision).toBe(0); expect(autosave.dirty).toBe(true);
  });

  it('can safely request an explicit retry from the error state callback before pending cleanup', async () => {
    const project = createProject('flight', 'Original');
    const save = vi.fn<Save>().mockRejectedValueOnce(new ApiError('Temporary outage', 503))
      .mockImplementation(async (snapshot, revision) => ({ ...snapshot, revision: revision + 1 }));
    let retry: Promise<void> | null = null;
    const autosave = new Autosave(project, save, (state) => {
      if (state.recovery === 'retry' && retry === null) retry = autosave.retry();
    });
    autosaves.push(autosave);
    autosave.update({ ...project, title: 'Edited' }); await autosave.flush(); await retry;
    expect(save).toHaveBeenCalledTimes(2); expect(autosave.revision).toBe(1); expect(autosave.dirty).toBe(false);
  });
});

describe('autosave response and lifetime safety', () => {
  it.each([
    { name: 'unchanged revision', change: (snapshot: ProjectDocument) => ({ ...snapshot }) },
    { name: 'regressing revision', change: (snapshot: ProjectDocument) => ({ ...snapshot, revision: snapshot.revision - 1 }) },
    { name: 'skipped revision', change: (snapshot: ProjectDocument) => ({ ...snapshot, revision: snapshot.revision + 2 }) },
    { name: 'different project', change: (snapshot: ProjectDocument) => ({ ...snapshot, id: 'another-flight', revision: snapshot.revision + 1 }) },
    { name: 'invalid document', change: (snapshot: ProjectDocument) => ({ ...snapshot, title: '', revision: snapshot.revision + 1 }) },
  ])('does not confirm a saved response with $name', async ({ change }) => {
    const save = vi.fn<Save>(async (snapshot) => change(snapshot));
    const { project, autosave, states } = setup(save, { ...createProject('flight', 'Original'), revision: 4 });
    autosave.update({ ...project, title: 'Edited' }); await autosave.flush();
    expect(autosave.revision).toBe(4); expect(autosave.dirty).toBe(true);
    expect(states.at(-1)).toMatchObject({ state: 'error', recovery: null, message: expect.stringContaining('unexpected revision') });
    await autosave.retry(); expect(save).toHaveBeenCalledTimes(1);
  });

  it('cancels debounce and ignores all later edits and flush/retry calls after disposal', async () => {
    const save = vi.fn<Save>(); const { project, autosave, states } = setup(save);
    autosave.update({ ...project, title: 'Edited' }); autosave.dispose(); const stateCount = states.length;
    autosave.update({ ...project, title: 'Ignored' }); await autosave.flush(); await autosave.retry();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(save).not.toHaveBeenCalled(); expect(states).toHaveLength(stateCount);
    expect(autosave.dirty).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a queued save if disposed before its first microtask', async () => {
    const save = vi.fn<Save>(); const { project, autosave, states } = setup(save);
    autosave.update({ ...project, title: 'Edited' }); const pending = autosave.flush(); autosave.dispose();
    const stateCount = states.length; await pending;
    expect(save).not.toHaveBeenCalled(); expect(states).toHaveLength(stateCount); expect(autosave.dirty).toBe(true);
  });

  it('does not apply a late successful response or report a disposed document as saved', async () => {
    const gate = deferred<ProjectDocument>(); const save = vi.fn<Save>(() => gate.promise);
    const { project, autosave, states } = setup(save, { ...createProject('flight', 'Original'), revision: 7 });
    autosave.update({ ...project, title: 'Edited' }); const pending = autosave.flush(); await vi.advanceTimersByTimeAsync(0);
    autosave.dispose(); const stateCount = states.length;
    gate.resolve({ ...project, title: 'Edited', revision: 8 }); await pending;
    expect(states).toHaveLength(stateCount); expect(autosave.revision).toBe(7); expect(autosave.dirty).toBe(true);
    expect(states.some((state) => state.state === 'saved')).toBe(false);
  });

  it('does not publish a late error or launch retry after disposal', async () => {
    const gate = deferred<ProjectDocument>(); const save = vi.fn<Save>(() => gate.promise);
    const { project, autosave, states } = setup(save);
    autosave.update({ ...project, title: 'Edited' }); const pending = autosave.flush(); await vi.advanceTimersByTimeAsync(0);
    autosave.dispose(); const stateCount = states.length;
    gate.reject(new ApiError('Late outage', 503)); await pending; await autosave.retry();
    expect(states).toHaveLength(stateCount); expect(save).toHaveBeenCalledTimes(1); expect(autosave.dirty).toBe(true);
  });

  it('does not send a write when a saving-state callback immediately disposes it', async () => {
    const project = createProject('flight', 'Original'); const save = vi.fn<Save>();
    const autosave = new Autosave(project, save, (state) => { if (state.state === 'saving') autosave.dispose(); });
    autosaves.push(autosave);
    autosave.update({ ...project, title: 'Edited' }); await autosave.flush();
    expect(save).not.toHaveBeenCalled(); expect(autosave.dirty).toBe(true);
  });
});
