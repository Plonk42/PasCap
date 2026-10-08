import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { AudioLibrary } from '../src/server/audio.js';
import { createConfig, type ServiceConfig } from '../src/server/config.js';
import { isNotFound, ServiceError } from '../src/server/errors.js';
import { assertNoSymlinks } from '../src/server/files.js';
import { JobQueue } from '../src/server/jobs.js';
import { MediaLibrary } from '../src/server/library.js';
import { runProcess } from '../src/server/process.js';
import { ProjectStore } from '../src/server/storage.js';
import { applyCommand } from '../src/shared/commands.js';
import { createClip, createProject, type ProjectDocument } from '../src/shared/model.js';
import { forEachSerial } from '../src/shared/serial.js';

const browserDataDir = path.resolve('.pascap/browser-tests');

export async function syntheticSources(
  config: ServiceConfig,
  names: readonly string[] = ['pattern-a.mp4', 'pattern-b.mp4'],
): Promise<string[]> {
  const directory = path.join(config.dataDir, 'synthetic-sources');
  await mkdir(directory, { recursive: true });
  const sources: string[] = [];
  await forEachSerial(names, async (name, index) => {
    const filename = path.join(directory, name);
    // Reuse existing synthetic originals; never replace an older fixture's files.
    try {
      if (!(await assertNoSymlinks(filename)).isFile())
        throw new ServiceError('Synthetic sources must be regular files.', 422);
      sources.push(filename);
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await runProcess(config.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-n',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=320x180:rate=30000/1001,${index ? 'hue=h=110' : 'null'},setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
      '-frames:v',
      '120',
      '-an',
      '-c:v',
      'libx264',
      '-threads',
      '2',
      '-filter_threads',
      '2',
      '-preset',
      'ultrafast',
      '-crf',
      '10',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '15',
      '-bf',
      '0',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-colorspace',
      'bt709',
      '-color_range',
      'tv',
      '-video_track_timescale',
      '30000',
      '-movflags',
      '+faststart',
      filename,
    ]);
    sources.push(filename);
  });
  return sources;
}

export async function preparedFixture(
  config: ServiceConfig,
): Promise<{ jobs: JobQueue; library: MediaLibrary; document: ProjectDocument }> {
  const store = new ProjectStore(config.dataDir);
  // Only the disposable browser context keeps the unversioned test ID.
  // The retained v6 suffix is a historical identifier, not the document schema.
  const projectId = path.resolve(config.dataDir) === browserDataDir ? 'preview-lab' : 'preview-lab-v6';
  let existing: ProjectDocument | null = null;
  try {
    existing = await store.load(projectId);
  } catch (error) {
    if (!(error instanceof ServiceError && error.statusCode === 404)) throw error;
  }
  const jobs = new JobQueue();
  const library = new MediaLibrary(config, jobs);
  await library.initialise();
  if (existing) return { jobs, library, document: existing };
  const sources = await syntheticSources(config);
  let document = createProject(projectId, 'Synthetic preview · disposable');
  const layerId = document.layers[0]!.id;
  await forEachSerial(sources, async (filename, index) => {
    const asset = await library.register(filename);
    const job = await library.prepare(asset.id);
    const result = await jobs.wait(job.id);
    if (result.state !== 'completed') throw new Error(result.message);
    document.media.videoIds.push(asset.id);
    document = applyCommand(document, {
      type: 'insert',
      clip: createClip(index === 0 ? 'clip-a' : 'clip-b', asset.id, 15, 105, layerId),
      index,
    });
  });
  document = applyCommand(document, {
    type: 'transition',
    transition: { leftId: 'clip-a', rightId: 'clip-b', type: 'cross-dissolve', duration: 18 },
  });
  document = await store.save(document, 0);
  return { jobs, library, document };
}

if (process.argv.includes('--browser')) {
  const config = createConfig({ dataDir: browserDataDir });
  // This dedicated test directory never contains a user's flight/edit.
  try {
    if (!(await assertNoSymlinks(config.dataDir)).isDirectory())
      throw new ServiceError('The browser fixture cache must be a directory.', 422);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await rm(config.dataDir, { recursive: true, force: true });
  const fixture = await preparedFixture(config);
  // No-copy browsing needs originals outside the cache it must not expose.
  // Generate separate disposable fixtures; never copy a user's recording.
  await syntheticSources(createConfig({ dataDir: path.resolve('.pascap/browser-footage') }), [
    'browse-camera-1.mp4',
    'browse-camera-2.mp4',
  ]);
  const originalSources = fixture.library.list();
  await forEachSerial([3, 4, 5, 6, 7, 8, 9, 10, 11, 12], async (index) => {
    const filename = path.join(config.dataDir, 'synthetic-sources', `recording-${String(index).padStart(2, '0')}.mp4`);
    await copyFile(originalSources[index % 2]!.sourcePath, filename);
    const asset = await fixture.library.register(filename);
    if (index === 3) {
      const job = await fixture.library.prepare(asset.id);
      const result = await fixture.jobs.wait(job.id);
      if (result.state !== 'completed') throw new Error(result.message);
    }
  });
  const musicFile = path.join(config.dataDir, 'synthetic-sources', 'test-music.wav');
  await runProcess(config.ffmpeg, [
    '-v',
    'error',
    '-nostdin',
    '-n',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=6',
    '-threads',
    '2',
    '-c:a',
    'pcm_s16le',
    musicFile,
  ]);
  const audio = new AudioLibrary(config, fixture.jobs);
  await audio.initialise();
  const registeredMusic = await audio.register(musicFile);
  const preparedMusic = await fixture.jobs.wait(registeredMusic.job.id);
  if (preparedMusic.state !== 'completed') throw new Error(preparedMusic.message);
  // The bin deliberately includes every fixture recording/music, even when tests clear the timeline.
  fixture.document.media = {
    videoIds: fixture.library.list().map((asset) => asset.id),
    audioIds: [registeredMusic.asset.id],
  };
  const store = new ProjectStore(config.dataDir);
  fixture.document = await store.save(fixture.document, fixture.document.revision);
  await fixture.jobs.close();
  console.log(
    'Disposable schema-11 browser fixture prepared (preview-lab): 12 project recordings, registered music, no placed music tracks, three verified video proxies.',
  );
}
