import type { VideoReaderCommand, VideoReaderReport } from './video-protocol.js';
import { VideoReader } from './video-source.js';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<VideoReaderCommand>) => void) | null;
  postMessage(message: VideoReaderReport, transfer: Transferable[]): void;
};
const reader = new VideoReader(
  {
    fetch: (url, init) => fetch(url, init),
    createDecoder: (init) => new VideoDecoder(init),
    supported: async (config) => (await VideoDecoder.isConfigSupported(config)).supported === true,
  },
  (message, transfer = []) => scope.postMessage(message, transfer),
);
scope.onmessage = ({ data }) => reader.receive(data);
