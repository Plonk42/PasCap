import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createConfig } from '../../src/server/config.js';
import { startExport } from '../../src/server/export.js';
import { readExportSpace } from '../../src/server/export-space.js';
import { fingerprintFile } from '../../src/server/files.js';
import { JobQueue } from '../../src/server/jobs.js';
import { MediaLibrary } from '../../src/server/library.js';
import { runProcess } from '../../src/server/process.js';
import { ProjectStore } from '../../src/server/storage.js';
import { createClip, createProject } from '../../src/shared/model.js';

// This helper runs ONLY inside the test's private user + mount namespace.
// It never mounts over an existing directory or uses sudo/host root privileges.
const root = process.argv[2];
if (!root || !path.isAbsolute(root) || !path.basename(root).startsWith('pascap-space-native-')) throw new Error('A disposable space-test root is required.');
const execute = promisify(execFile);
const cache = path.join(root, 'bounded-cache');
await mkdir(cache);
await execute('mount', ['-t', 'tmpfs', '-o', 'size=32m,mode=0700', 'tmpfs', cache]);
const jobs = new JobQueue();
try {
  const config = createConfig({ dataDir: cache });
  const sources = path.join(root, 'sources'); await mkdir(sources);
  const source = path.join(sources, 'synthetic-noise.mp4');
  await runProcess(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-f', 'lavfi', '-i',
    'testsrc2=size=1280x720:rate=30000/1001,noise=alls=100:allf=t,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
    '-frames:v', '60', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-pix_fmt', 'yuv420p', '-bf', '0',
    '-threads', '2', '-filter_threads', '2', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-video_track_timescale', '30000', source]);
  const original = await fingerprintFile(source);
  const library = new MediaLibrary(config, jobs); await library.initialise();
  const asset = await library.register(source);
  const short = createProject('space-preserved', 'Disposable space safety');
  short.media.videoIds = [asset.id]; short.clips = [createClip('short', asset.id, 0, 2)];
  const previous = startExport(short, 'draft720', library);
  const completed = await jobs.wait(previous.id);
  assert.equal(completed.state, 'completed', completed.message);
  const success = path.join(cache, 'renders', completed.id);
  const previousBytes = await readFile(path.join(success, 'export.mp4'));
  const previousReceipt = await readFile(path.join(success, 'receipt.json'));
  const store = new ProjectStore(cache);
  const saved = await store.save(short, 0);
  const savedPath = path.join(cache, 'projects', `${saved.id}.json`);
  const savedBytes = await readFile(savedPath);
  const full = { ...short, clips: [createClip('full', asset.id, 0, 60)] };
  const preflight = await readExportSpace(cache, full, 'draft720');
  assert.equal(preflight.status, 'tight');
  const failed = startExport(full, 'draft720', library);
  const result = await jobs.wait(failed.id);
  assert.equal(result.state, 'failed', result.message);
  assert.match(result.message, /ran out of space/);
  assert.match(result.message, /start a new export/);
  assert.equal(result.outputUrl, null); assert.equal(result.receiptUrl, null);
  assert.deepEqual(await readdir(path.join(cache, 'renders')), [completed.id]);
  assert.deepEqual(await readFile(path.join(success, 'export.mp4')), previousBytes);
  assert.deepEqual(await readFile(path.join(success, 'receipt.json')), previousReceipt);
  assert.deepEqual(await readFile(savedPath), savedBytes);
  assert.deepEqual(await fingerprintFile(source), original);
  const disk = await statfs(cache, { bigint: true });
  console.log(JSON.stringify({
    capacityBytes: Number(disk.blocks * disk.bsize), availableBefore: preflight.availableBytes,
    availableAfterCleanup: Number(disk.bavail * disk.bsize), allowanceBytes: preflight.estimate.totalBytes,
    failure: result.message, previousExportPreserved: true, savedProjectPreserved: true, originalPreserved: true, partialPublished: false,
  }));
} finally {
  await jobs.close();
  await execute('umount', [cache]);
}