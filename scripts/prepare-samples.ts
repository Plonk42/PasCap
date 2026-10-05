import path from 'node:path';
import { createConfig } from '../src/server/config.js';
import { errorMessage, ServiceError } from '../src/server/errors.js';
import { JobQueue } from '../src/server/jobs.js';
import { MediaLibrary } from '../src/server/library.js';
import { ProjectStore } from '../src/server/storage.js';
import { applyCommand } from '../src/shared/commands.js';
import type { MediaAsset, ProxyVerification } from '../src/shared/media.js';
import { createClip, createProject } from '../src/shared/model.js';
import { forEachSerial } from '../src/shared/serial.js';

function formatSample(sample: ProxyVerification['samples'][number]): string {
  return `${sample.frame} → ${sample.meanAbsoluteError8Bit.toFixed(3)}`;
}

const folderArgument = process.argv[2];
if (!folderArgument) throw new Error('Pass the source folder explicitly: npm run prepare:samples -- /absolute/path/to/footage. This opt-in script prepares DJI_0468.MP4 and DJI_0469.MP4; it never discovers a personal folder automatically.');
const folder = path.resolve(folderArgument);
const names = ['DJI_0468.MP4', 'DJI_0469.MP4'];
const sampleId = 'sample-taillefer-v6';
const config = createConfig();
const jobs = new JobQueue(); const library = new MediaLibrary(config, jobs); const store = new ProjectStore(config.dataDir);
await library.initialise();
try {
  const assets: MediaAsset[] = [];
  await forEachSerial(names, async (name) => {
    console.log(`Read-only source: ${path.join(folder, name)}`);
    const registered = await library.register(path.join(folder, name));
    // Preparation remains explicit/manual; the library reuses verified cached proxies.
    const job = await library.prepare(registered.id);
    const result = await jobs.wait(job.id);
    if (result.state !== 'completed') throw new Error(result.message);
    const asset = library.get(registered.id); assets.push(asset);
    console.log(`Verified ${name}: ${asset.metadata.frameCount} frames, ${asset.prepared?.width}×${asset.prepared?.height}`);
    const samples = asset.prepared?.verification.samples.map(formatSample).join(', ');
    console.log(`Frame correspondence MAE / 255: ${samples}`);
  });
  try { await store.load(sampleId); console.log('Existing v6 sample project kept unchanged.'); }
  catch (error) {
    if (!(error instanceof ServiceError && error.statusCode === 404)) throw error;
    let project = createProject(sampleId, 'Taillefer · Sample edit');
    const layerId = project.layers[0]!.id;
    project.media.videoIds = assets.map((asset) => asset.id);
    for (const [index, asset] of assets.entries()) {
      if (asset.metadata.frameCount < 210) throw new Error('Sample needs at least 210 source frames.');
      project = applyCommand(project, { type: 'insert', clip: createClip(`clip-${index === 0 ? 'a' : 'b'}`, asset.id, 30, 210, layerId), index });
    }
    project = applyCommand(project, { type: 'transition', transition: { leftId: 'clip-a', rightId: 'clip-b', type: 'cross-dissolve', duration: 30 } });
    project = applyCommand(project, { type: 'fades', layerId, opening: 12, closing: 12 });
    await store.save(project, 0); console.log(`Saved a new v6 sample edit (${sampleId}); earlier v1/v2/v3/v4/v5 projects remain untouched and incompatible. No migration is performed.`);
  }
} catch (error) { console.error(errorMessage(error)); process.exitCode = 1; }
finally { await jobs.close(); }