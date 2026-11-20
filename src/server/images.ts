import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { imagesFileSchema, MAX_IMAGES, type ImageAsset, type ImageRegistration } from '../shared/images.js';
import { forEachSerial } from '../shared/serial.js';
import { analysisSize, type AnalysisFrame } from '../shared/white-balance.js';
import { readAnalysisFrame } from './analysis-frame.js';
import type { ServiceConfig } from './config.js';
import { errorMessage, isNotFound, ServiceError } from './errors.js';
import { assertSourceIdentity, fingerprintFile } from './files.js';
import { IMAGE_HEADER_BYTES, readImageInfo } from './image-header.js';
import { atomicWrite } from './storage.js';

const IMAGE_REGISTRY = 'images.json';

/**
 * Registered still images in `<dataDir>/images.json`: JPEG and PNG originals referenced in place, never copied or
 * modified. Registering reads only their header and fingerprint; the editor decodes them itself.
 */
export class ImageLibrary {
  readonly #file: string;
  readonly #images = new Map<string, ImageAsset>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: Pick<ServiceConfig, 'dataDir' | 'ffmpeg'>) {
    this.#file = path.join(config.dataDir, IMAGE_REGISTRY);
  }

  /** Reads the registry; one this build cannot read stops the service, never replaced. */
  async initialize(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.#file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    const parsed = imagesFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`${IMAGE_REGISTRY} cannot be read by this version; it is left unchanged.`);
    for (const image of parsed.data.images) this.#images.set(image.id, image);
  }

  list(): ImageAsset[] {
    return [...this.#images.values()];
  }

  get(id: string): ImageAsset {
    const image = this.#images.get(id);
    if (!image) throw new ServiceError(`No image ${id} is registered.`, 404);
    return image;
  }

  /** Images whose original is no longer at its registered path, unchanged. */
  async missing(): Promise<string[]> {
    const missing: string[] = [];
    await forEachSerial(this.list(), async (image) => {
      try {
        await assertSourceIdentity(image.sourcePath, image.fingerprint);
      } catch {
        missing.push(image.id);
      }
    });
    return missing;
  }

  /**
   * Registers each image, one at a time; an image already registered at that path keeps its id, with its size and
   * fingerprint read again. Paths are validated by the caller.
   */
  register(paths: readonly string[]): Promise<ImageRegistration> {
    return this.#serial(async () => {
      const before = new Map(this.#images);
      const result: ImageRegistration = { images: [], errors: [] };
      await forEachSerial(paths, async (filename) => {
        try {
          result.images.push(await this.#registerOne(filename));
        } catch (error) {
          result.errors.push({ path: filename, message: errorMessage(error) });
        }
      });
      if (!result.images.length) return result;
      try {
        await this.#write();
      } catch (error) {
        this.#images.clear();
        for (const [id, image] of before) this.#images.set(id, image);
        throw error;
      }
      return result;
    });
  }

  /** The registered original, unchanged since registration. */
  async original(id: string): Promise<ImageAsset> {
    const image = this.get(id);
    try {
      await assertSourceIdentity(image.sourcePath, image.fingerprint);
    } catch (error) {
      if (!(error instanceof ServiceError) || error.statusCode !== 409) throw error;
      throw new ServiceError(
        `${image.name} is no longer at ${image.sourcePath} as imported: restore it there, or import it again.`,
        409,
      );
    }
    return image;
  }

  /** The image at the analysis size, decoded by FFmpeg: JPEG only, the qualified build has no PNG decoder. */
  async analysisFrame(id: string): Promise<AnalysisFrame> {
    const image = await this.original(id);
    if (image.format !== 'jpeg')
      throw new ServiceError(
        `${image.name} is a PNG image: the service reads JPEG images only. Match it in the editor, or use a JPEG copy.`,
        422,
      );
    return readAnalysisFrame(this.config, image.sourcePath, analysisSize(image.width, image.height), null);
  }

  async #registerOne(filename: string): Promise<ImageAsset> {
    const name = path.basename(filename);
    let fingerprint: ImageAsset['fingerprint'];
    let header: Uint8Array;
    try {
      fingerprint = await fingerprintFile(filename);
      const handle = await open(filename, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(IMAGE_HEADER_BYTES, fingerprint.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        header = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isNotFound(error)) throw new ServiceError(`${name} is missing.`, 404);
      throw error;
    }
    const info = readImageInfo(header);
    if (!info) throw new ServiceError(`${name} is not a JPEG or PNG image PasCap can read.`, 422);
    const known = this.list().find((image) => image.sourcePath === filename);
    if (!known && this.#images.size >= MAX_IMAGES)
      throw new ServiceError(`At most ${MAX_IMAGES} images can be registered.`, 409);
    const image: ImageAsset = {
      id: known?.id ?? randomUUID(),
      name,
      sourcePath: filename,
      ...info,
      fingerprint,
      registeredAt: known?.registeredAt ?? new Date().toISOString(),
    };
    this.#images.set(image.id, image);
    return image;
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #write(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    const file = imagesFileSchema.parse({ version: 1, images: this.list() });
    await atomicWrite(this.#file, `${JSON.stringify(file, null, 2)}\n`);
  }
}
