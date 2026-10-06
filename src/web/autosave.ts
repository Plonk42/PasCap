import { projectSchema, type ProjectDocument } from '../shared/model.js';
import { whileSerial } from '../shared/serial.js';
import { ApiError } from './api.js';

export interface SaveState {
  state: 'saved' | 'unsaved' | 'saving' | 'error';
  message: string;
  revision: number;
  recovery: 'retry' | 'conflict' | null;
}

function saveFailure(error: unknown): Pick<SaveState, 'message' | 'recovery'> {
  let message = 'Save failed. Keep this draft and check the local service before continuing.';
  if (error instanceof Error && error.message.trim()) message = error.message;
  else if (typeof error === 'string' && error.trim()) message = error;
  let recovery: SaveState['recovery'] = null;
  if (error instanceof ApiError) {
    if (error.status === 409) recovery = 'conflict';
    else if (error.retryable) recovery = 'retry';
  }
  return { message, recovery };
}

/** Debounced, serial saves. An older response cannot mark newer changes as saved. */
export class Autosave {
  #document: ProjectDocument;
  #generation = 0;
  #savedGeneration = 0;
  #revision: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: Promise<void> | null = null;
  #disposed = false;
  #failure: Pick<SaveState, 'message' | 'recovery'> | null = null;
  constructor(
    document: ProjectDocument,
    private readonly save: (document: ProjectDocument, revision: number) => Promise<ProjectDocument>,
    private readonly onState: (state: SaveState) => void,
  ) {
    this.#document = projectSchema.parse(document);
    this.#revision = this.#document.revision;
  }
  get dirty(): boolean {
    return this.#generation !== this.#savedGeneration;
  }
  get revision(): number {
    return this.#revision;
  }
  update(document: ProjectDocument): void {
    if (this.#disposed) return;
    const next = projectSchema.parse(document);
    if (next.id !== this.#document.id)
      throw new Error('Cannot autosave a different project. Open that project separately.');
    this.#document = next;
    this.#generation++;
    this.#clearTimer();
    if (this.#failure === null)
      this.#timer = setTimeout(() => {
        void this.flush();
      }, 600);
    this.onState(
      this.#failure === null
        ? { state: 'unsaved', message: 'Unsaved changes', revision: this.#revision, recovery: null }
        : { state: 'error', ...this.#failure, revision: this.#revision },
    );
  }
  async flush(): Promise<void> {
    this.#clearTimer();
    await whileSerial(
      () => this.dirty && !this.#disposed && this.#failure === null,
      () => {
        if (this.#pending === null) {
          this.#clearTimer();
          const generation = this.#generation;
          const revision = this.#revision;
          const snapshot = projectSchema.parse({ ...this.#document, revision });
          // Register the pending save before emitting state or calling user code, including synchronous callbacks.
          this.#pending = Promise.resolve()
            .then(() => this.#persist(snapshot, generation, revision))
            .finally(() => {
              this.#pending = null;
            });
          this.onState({ state: 'saving', message: 'Saving locally…', revision, recovery: null });
        }
        // Wait for this revision before considering any newer edits.
        return this.#pending;
      },
    );
  }
  /** Explicit recovery only. A conflict never rebases or changes the original expected revision. */
  async retry(): Promise<void> {
    if (this.#disposed || this.#failure?.recovery !== 'retry') return;
    if (this.#pending !== null) await this.#pending;
    if (this.#disposed || this.#failure?.recovery !== 'retry') return;
    this.#failure = null;
    await this.flush();
  }
  async #persist(snapshot: ProjectDocument, generation: number, revision: number): Promise<void> {
    if (this.#disposed) return;
    let saved: ProjectDocument;
    try {
      const result = await this.save(snapshot, revision);
      if (this.#disposed) return;
      const parsed = projectSchema.safeParse(result);
      if (!parsed.success || parsed.data.id !== snapshot.id || parsed.data.revision !== revision + 1) {
        throw new ApiError(
          'The service returned an invalid saved project or unexpected revision. Keep this draft and reload the latest project before saving again.',
          200,
          'response',
        );
      }
      saved = parsed.data;
    } catch (error: unknown) {
      if (this.#disposed) return;
      this.#clearTimer();
      this.#failure = saveFailure(error);
      this.onState({ state: 'error', ...this.#failure, revision: this.#revision });
      return;
    }
    this.#revision = saved.revision;
    this.#savedGeneration = generation;
    this.onState({
      state: this.dirty ? 'unsaved' : 'saved',
      message: this.dirty ? 'New changes awaiting save' : 'Saved on this device',
      revision: this.#revision,
      recovery: null,
    });
  }
  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
  dispose(): void {
    this.#disposed = true;
    this.#clearTimer();
  }
}
