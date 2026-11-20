import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { autoEditResultSchema, type AutoEditResult } from '../shared/auto-edit/result.js';
import { idSchema } from '../shared/model.js';
import { forEachSerial } from '../shared/serial.js';
import { isNotFound, ServiceError } from './errors.js';
import { assertNoSymlinks } from './files.js';
import { atomicWrite, SerialWriter } from './storage.js';

/** Results kept; older ones are removed, never a project. */
const KEPT_RESULTS = 30;
const MAX_RESULT_BYTES = 20 * 1024 * 1024;

/** Finished editor auto edits in `<dataDir>/auto-edit/<job id>.json`, so the editor can open them after the job. */
export class AutoEditResults {
  readonly #writer = new SerialWriter();
  constructor(private readonly dataDir: string) {}

  #directory(): string {
    return path.join(this.dataDir, 'auto-edit');
  }
  #file(id: string): string {
    return path.join(this.#directory(), `${idSchema.parse(id)}.json`);
  }

  save(result: AutoEditResult): Promise<void> {
    return this.#writer.run(async () => {
      await atomicWrite(this.#file(result.id), `${JSON.stringify(autoEditResultSchema.parse(result))}\n`);
      await this.#prune();
    });
  }

  async get(id: string): Promise<AutoEditResult> {
    const filename = this.#file(id);
    try {
      const info = await assertNoSymlinks(filename);
      if (!info.isFile() || info.size > MAX_RESULT_BYTES) throw new ServiceError('Invalid auto edit result.', 422);
      return autoEditResultSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
    } catch (error) {
      if (isNotFound(error)) throw new ServiceError('This auto edit is no longer kept; run it again.', 404);
      throw error;
    }
  }

  async #prune(): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.#directory())).filter((name) => name.endsWith('.json'));
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    if (names.length <= KEPT_RESULTS) return;
    const dated: { name: string; time: number }[] = [];
    await forEachSerial(names, async (name) => {
      dated.push({ name, time: (await stat(path.join(this.#directory(), name))).mtimeMs });
    });
    dated.sort((left, right) => right.time - left.time);
    await forEachSerial(dated.slice(KEPT_RESULTS), ({ name }) =>
      rm(path.join(this.#directory(), name), { force: true }),
    );
  }
}
