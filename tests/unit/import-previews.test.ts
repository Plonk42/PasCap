import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_REQUESTS,
  PreviewLoader,
  previewKey,
  type ObserverFactory,
  type PreviewState,
} from '../../src/web/import-previews.js';

type Callback = Parameters<ObserverFactory>[0];

function harness() {
  let notify: Callback = () => {};
  const observed = new Set<Element>();
  const requests: {
    path: string;
    signal: AbortSignal;
    resolve: (image: Blob) => void;
    reject: (error: Error) => void;
  }[] = [];
  const loader = new PreviewLoader(
    (path, signal) =>
      new Promise<Blob>((resolve, reject) => {
        requests.push({ path, signal, resolve, reject });
      }),
    (callback) => {
      notify = callback;
      return { observe: (element) => observed.add(element), unobserve: (element) => observed.delete(element) };
    },
  );
  const rows = new Map<string, { element: Element; states: PreviewState[]; stop: () => void }>();
  const watch = (path: string, size = 100) => {
    const element = { path } as unknown as Element;
    const states: PreviewState[] = [];
    const stop = loader.watch(element, previewKey({ path, size }), path, (state) => states.push(state));
    rows.set(path, { element, states, stop });
    return rows.get(path)!;
  };
  const show = (...paths: string[]) =>
    notify(paths.map((path) => ({ target: rows.get(path)!.element, isIntersecting: true })));
  const hide = (...paths: string[]) =>
    notify(paths.map((path) => ({ target: rows.get(path)!.element, isIntersecting: false })));
  return { loader, observed, requests, rows, watch, show, hide };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Import dialog preview loading', () => {
  it('fetches only visible rows, top to bottom, at most two at a time', async () => {
    const url = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:preview');
    const { requests, watch, show, rows } = harness();
    ['a', 'b', 'c', 'd'].forEach((path) => watch(path));
    expect(rows.get('a')!.states).toEqual([{ status: 'waiting' }]);
    expect(requests).toHaveLength(0);

    show('d', 'c', 'b');
    expect(PREVIEW_REQUESTS).toBe(2);
    expect(requests.map((request) => request.path)).toEqual(['b', 'c']);
    requests[0]!.resolve(new Blob(['jpeg'], { type: 'image/jpeg' }));
    await flush();
    expect(rows.get('b')!.states.at(-1)).toEqual({ status: 'ready', url: 'blob:preview' });
    expect(requests.map((request) => request.path)).toEqual(['b', 'c', 'd']);
    expect(url).toHaveBeenCalledTimes(1);
    // A remount of a loaded row reuses its image.
    rows.get('b')!.stop();
    expect(watch('b').states).toEqual([{ status: 'ready', url: 'blob:preview' }]);
    expect(requests).toHaveLength(3);
  });

  it('cancels a read when its row unmounts and keeps reads running while merely scrolled away', async () => {
    const { requests, watch, show, hide, rows } = harness();
    ['a', 'b', 'c'].forEach((path) => watch(path));
    show('a', 'b', 'c');
    hide('a');
    expect(requests[0]!.signal.aborted).toBe(false);
    rows.get('b')!.stop();
    expect(requests[1]!.signal.aborted).toBe(true);
    expect(requests.map((request) => request.path)).toEqual(['a', 'b', 'c']);
    requests[1]!.resolve(new Blob(['late']));
    await flush();
    expect(rows.get('b')!.states).toEqual([{ status: 'waiting' }]);
  });

  it('shows an explicit failure, retries it only when asked, and releases everything on dispose', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:preview');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { loader, requests, watch, show, rows } = harness();
    watch('broken');
    watch('good');
    watch('slow');
    show('broken', 'good');
    requests[0]!.reject(new Error('No preview: this file could not be decoded as video.'));
    requests[1]!.resolve(new Blob(['jpeg']));
    await flush();
    expect(rows.get('broken')!.states.at(-1)).toEqual({
      status: 'failed',
      reason: 'No preview: this file could not be decoded as video.',
    });
    show('broken');
    expect(requests).toHaveLength(2);

    loader.forgetFailures();
    expect(rows.get('broken')!.states.at(-1)).toEqual({ status: 'waiting' });
    expect(requests.map((request) => request.path)).toEqual(['broken', 'good', 'broken']);
    show('slow');
    loader.dispose();
    expect(requests.at(-1)!.signal.aborted).toBe(true);
    expect(revoke).toHaveBeenCalledWith('blob:preview');
  });

  it('treats a changed size as a different recording', () => {
    expect(previewKey({ path: '/a.mp4', size: 1 })).not.toBe(previewKey({ path: '/a.mp4', size: 2 }));
  });
});
