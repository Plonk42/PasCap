import { MusicReader, type MusicReaderCommand, type MusicReaderReport } from './music-source.js';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<MusicReaderCommand>) => void) | null;
  postMessage(message: MusicReaderReport, transfer: Transferable[]): void;
};
const reader = new MusicReader((message, transfer = []) => scope.postMessage(message, transfer));
scope.onmessage = ({ data }) => reader.receive(data);
