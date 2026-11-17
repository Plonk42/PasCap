import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConfig } from '../../src/server/config.js';
import { ImageLibrary } from '../../src/server/images.js';
import { runProcess } from '../../src/server/process.js';
import { measureLook } from '../../src/shared/look-match.js';
import { analysisSize } from '../../src/shared/white-balance.js';

const enabled = process.env['PASCAP_MEDIA_TESTS'] === '1';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!enabled)('registered images · disposable native fixture', () => {
  it('reads a JPEG image at the analysis size for the assistant’s match', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pascap-images-native-'));
    roots.push(root);
    const sources = path.join(root, 'sources');
    await mkdir(sources);
    const config = createConfig({ dataDir: path.join(root, 'cache'), mediaRoots: [sources] });
    const photo = path.join(sources, 'look.jpg');
    await runProcess(config.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=1600x900',
      '-frames:v',
      '1',
      photo,
    ]);
    const library = new ImageLibrary(config);
    const { images } = await library.register([photo]);
    expect(images[0]).toMatchObject({ format: 'jpeg', width: 1600, height: 900 });
    const frame = await library.analysisFrame(images[0]!.id);
    expect({ width: frame.width, height: frame.height }).toEqual(analysisSize(1600, 900));
    expect(measureLook([frame])).not.toBeNull();
  });
});
