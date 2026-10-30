import { parentPort } from 'node:worker_threads';
import { errorMessage } from './errors.js';
import { analyzeMusicFile, type MusicWorkerReply } from './music-analysis.js';

const port = parentPort!;
port.once('message', (filename: string) => {
  analyzeMusicFile(filename, (progress) => port.postMessage({ progress } satisfies MusicWorkerReply)).then(
    (measurement) => port.postMessage({ measurement } satisfies MusicWorkerReply),
    (error: unknown) => port.postMessage({ error: errorMessage(error) } satisfies MusicWorkerReply),
  );
});
