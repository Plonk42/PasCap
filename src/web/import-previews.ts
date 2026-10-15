/** Previews in the Import dialog: fetched only while their row is visible, a few at a time. */

export type PreviewState =
  { status: 'waiting' } | { status: 'ready'; url: string } | { status: 'failed'; reason: string };

export type FetchPreview = (path: string, signal: AbortSignal) => Promise<Blob>;
export type ObserverFactory = (
  callback: (entries: readonly Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void,
) => Pick<IntersectionObserver, 'observe' | 'unobserve'>;

/** Browsers allow about six connections per host: leave room for the import itself. */
export const PREVIEW_REQUESTS = 2;

interface Watcher {
  key: string;
  path: string;
  visible: boolean;
  listener: (state: PreviewState) => void;
}

/** A file's identity as far as browsing knows: a replaced recording usually changes size. */
export function previewKey(entry: { path: string; size: number | null }): string {
  return `${entry.size ?? ''}:${entry.path}`;
}

export class PreviewLoader {
  readonly #results = new Map<string, PreviewState>();
  readonly #watchers = new Map<Element, Watcher>();
  readonly #running = new Map<string, AbortController>();
  readonly #observer: Pick<IntersectionObserver, 'observe' | 'unobserve'>;

  constructor(
    private readonly fetchPreview: FetchPreview,
    createObserver: ObserverFactory = (callback) => new IntersectionObserver(callback),
  ) {
    this.#observer = createObserver((entries) => {
      entries.forEach((entry) => {
        const watcher = this.#watchers.get(entry.target);
        if (watcher) watcher.visible = entry.isIntersecting;
      });
      this.#pump();
    });
  }

  /** Follow one row's preview; the listener receives the current state at once. */
  watch(element: Element, key: string, path: string, listener: (state: PreviewState) => void): () => void {
    this.#watchers.set(element, { key, path, visible: false, listener });
    listener(this.#results.get(key) ?? { status: 'waiting' });
    this.#observer.observe(element);
    return () => this.#unwatch(element);
  }

  /** Retry failed previews, for example after Refresh. */
  forgetFailures(): void {
    [...this.#results].forEach(([key, state]) => {
      if (state.status === 'failed') this.#results.delete(key);
    });
    this.#watchers.forEach((watcher) => {
      if (!this.#results.has(watcher.key)) watcher.listener({ status: 'waiting' });
    });
    this.#pump();
  }

  /** Cancel reads and release images, for example when the dialog closes. */
  dispose(): void {
    this.#running.forEach((controller) => controller.abort());
    this.#running.clear();
    this.#results.forEach((state) => {
      if (state.status === 'ready') URL.revokeObjectURL(state.url);
    });
    this.#results.clear();
  }

  #unwatch(element: Element): void {
    const watcher = this.#watchers.get(element);
    if (!watcher) return;
    this.#watchers.delete(element);
    this.#observer.unobserve(element);
    const controller = this.#running.get(watcher.key);
    if (controller && ![...this.#watchers.values()].some((other) => other.key === watcher.key)) {
      controller.abort();
      this.#running.delete(watcher.key);
      this.#pump();
    }
  }

  /** Start visible previews top to bottom, never more than PREVIEW_REQUESTS at once. */
  #pump(): void {
    for (const watcher of this.#watchers.values()) {
      if (this.#running.size >= PREVIEW_REQUESTS) return;
      if (watcher.visible && !this.#results.has(watcher.key) && !this.#running.has(watcher.key))
        this.#start(watcher.key, watcher.path);
    }
  }

  #start(key: string, path: string): void {
    const controller = new AbortController();
    this.#running.set(key, controller);
    this.fetchPreview(path, controller.signal)
      .then(
        (image) => {
          if (!controller.signal.aborted) this.#settle(key, { status: 'ready', url: URL.createObjectURL(image) });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            this.#settle(key, {
              status: 'failed',
              reason: error instanceof Error ? error.message : 'The preview could not be read.',
            });
        },
      )
      .finally(() => {
        if (this.#running.get(key) !== controller) return;
        this.#running.delete(key);
        this.#pump();
      });
  }

  #settle(key: string, state: PreviewState): void {
    this.#results.set(key, state);
    this.#watchers.forEach((watcher) => {
      if (watcher.key === key) watcher.listener(state);
    });
  }
}
