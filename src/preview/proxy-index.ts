import type { FrameRate } from '../shared/timing.js';

/**
 * Sample table of one editing proxy (H.264, no reordering, constant 30000/1001
 * frame duration, index before the media). Sample i is original source frame i.
 */
export interface ProxyIndex {
  codec: string;
  description: Uint8Array<ArrayBuffer>;
  width: number;
  height: number;
  frameCount: number;
  offsets: Float64Array;
  sizes: Uint32Array;
  keyframes: Uint8Array;
}

interface Box {
  type: string;
  start: number;
  body: number;
  end: number;
}

function unsupported(reason: string): Error {
  return new Error(`Unsupported editing proxy: ${reason}. Prepare the recording again.`);
}

function* boxes(view: DataView, start: number, end: number): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) throw unsupported('truncated box header');
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header) throw unsupported('invalid box size');
    const type = String.fromCodePoint(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7),
    );
    yield { type, start: offset, body: offset + header, end: offset + size };
    offset += size;
  }
}

function child(view: DataView, parent: Box, type: string): Box | null {
  for (const box of boxes(view, parent.body, parent.end)) if (box.type === type) return box;
  return null;
}

function required(view: DataView, parent: Box, ...path: string[]): Box {
  let box = parent;
  for (const type of path) {
    const next = child(view, box, type);
    if (!next) throw unsupported(`missing ${type} box`);
    box = next;
  }
  return box;
}

/** The index box must precede the media so one bounded read finds it. */
export function locateIndex(head: Uint8Array): { start: number; end: number } {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  for (const box of boxes(view, 0, head.byteLength)) {
    if (box.type === 'moov') return { start: box.start, end: box.end };
    if (box.type === 'mdat') throw unsupported('its index follows the media (faststart is required)');
    if (box.end > head.byteLength) break;
  }
  throw unsupported('no index at the start of the file');
}

function videoTrack(view: DataView, bytes: Uint8Array, moov: Box): Box {
  const tracks = [...boxes(view, moov.body, moov.end)].filter((box) => {
    if (box.type !== 'trak') return false;
    const handler = required(view, box, 'mdia', 'hdlr');
    return String.fromCodePoint(...bytes.subarray(handler.body + 8, handler.body + 12)) === 'vide';
  });
  if (tracks.length !== 1) throw unsupported('it must contain exactly one video track');
  return tracks[0]!;
}

function checkEdits(view: DataView, track: Box): void {
  const edits = child(view, track, 'edts');
  const list = edits && child(view, edits, 'elst');
  if (!list) return;
  const version = view.getUint8(list.body);
  const entries = view.getUint32(list.body + 4);
  if (entries === 0) return;
  const mediaTime = version === 1 ? Number(view.getBigInt64(list.body + 8 + 8)) : view.getInt32(list.body + 8 + 4);
  if (entries !== 1 || mediaTime !== 0) throw unsupported('its edit list shifts frames');
}

function sampleTiming(view: DataView, table: Box, timescale: number, rate: FrameRate): number {
  if (child(view, table, 'ctts')) throw unsupported('it uses reordered (B) frames');
  const stts = required(view, table, 'stts');
  let samples = 0;
  for (let entry = 0; entry < view.getUint32(stts.body + 4); entry++) {
    const count = view.getUint32(stts.body + 8 + entry * 8);
    const delta = view.getUint32(stts.body + 12 + entry * 8);
    if (delta * rate.numerator !== timescale * rate.denominator)
      throw unsupported(`frame duration is not ${rate.denominator}/${rate.numerator} s`);
    samples += count;
  }
  return samples;
}

function sampleSizes(view: DataView, table: Box): Uint32Array {
  const stsz = required(view, table, 'stsz');
  const fixed = view.getUint32(stsz.body + 4);
  const sizes = new Uint32Array(view.getUint32(stsz.body + 8));
  for (let sample = 0; sample < sizes.length; sample++)
    sizes[sample] = fixed || view.getUint32(stsz.body + 12 + sample * 4);
  return sizes;
}

function sampleOffsets(view: DataView, table: Box, sizes: Uint32Array): Float64Array {
  const stco = child(view, table, 'stco');
  const co64 = stco ? null : required(view, table, 'co64');
  const chunks = view.getUint32((stco ?? co64)!.body + 4);
  const chunkOffset = (chunk: number): number =>
    stco ? view.getUint32(stco.body + 8 + chunk * 4) : Number(view.getBigUint64(co64!.body + 8 + chunk * 8));
  const stsc = required(view, table, 'stsc');
  const runs = Array.from({ length: view.getUint32(stsc.body + 4) }, (_value, entry) => ({
    first: view.getUint32(stsc.body + 8 + entry * 12) - 1,
    samples: view.getUint32(stsc.body + 12 + entry * 12),
  }));
  const offsets = new Float64Array(sizes.length);
  let sample = 0;
  let run = 0;
  for (let chunk = 0; chunk < chunks && sample < sizes.length; chunk++) {
    while (run + 1 < runs.length && runs[run + 1]!.first <= chunk) run++;
    let offset = chunkOffset(chunk);
    for (let index = 0; index < (runs[run]?.samples ?? 0) && sample < sizes.length; index++) {
      offsets[sample] = offset;
      offset += sizes[sample++]!;
    }
  }
  if (sample !== sizes.length) throw unsupported('its chunk table does not cover every frame');
  for (let index = 1; index < offsets.length; index++)
    if (offsets[index]! < offsets[index - 1]! + sizes[index - 1]!) throw unsupported('frames are not stored in order');
  return offsets;
}

function sampleKeys(view: DataView, table: Box, count: number): Uint8Array {
  const keyframes = new Uint8Array(count);
  const stss = child(view, table, 'stss');
  if (!stss) return keyframes.fill(1);
  for (let entry = 0; entry < view.getUint32(stss.body + 4); entry++) {
    const sample = view.getUint32(stss.body + 8 + entry * 4) - 1;
    if (sample < 0 || sample >= count) throw unsupported('a keyframe is outside the frame table');
    keyframes[sample] = 1;
  }
  if (!keyframes[0]) throw unsupported('the first frame is not a keyframe');
  return keyframes;
}

/** `bytes` holds the file from offset 0 through the end of its index box. */
export function parseProxyIndex(bytes: Uint8Array, rate: FrameRate): ProxyIndex {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const location = locateIndex(bytes);
  if (location.end > bytes.byteLength) throw unsupported('its index is truncated');
  const moov: Box = { type: 'moov', start: location.start, body: location.start + 8, end: location.end };
  const track = videoTrack(view, bytes, moov);
  checkEdits(view, track);
  const header = required(view, track, 'mdia', 'mdhd');
  const timescale = view.getUint32(header.body + (view.getUint8(header.body) === 1 ? 20 : 12));
  const table = required(view, track, 'mdia', 'minf', 'stbl');
  const stsd = required(view, table, 'stsd');
  if (view.getUint32(stsd.body + 4) !== 1) throw unsupported('it must have one sample description');
  const entry = boxes(view, stsd.body + 8, stsd.end).next().value;
  if (!entry || !['avc1', 'avc3'].includes(entry.type)) throw unsupported('it is not H.264');
  const width = view.getUint16(entry.body + 24);
  const height = view.getUint16(entry.body + 26);
  let avcC: Box | null = null;
  for (const box of boxes(view, entry.body + 78, entry.end)) if (box.type === 'avcC') avcC = box;
  if (!avcC || avcC.end - avcC.body < 4) throw unsupported('it has no H.264 configuration');
  const description = bytes.slice(avcC.body, avcC.end);
  const hex = (value: number): string => value.toString(16).padStart(2, '0');
  const codec = `avc1.${hex(description[1]!)}${hex(description[2]!)}${hex(description[3]!)}`;
  const timed = sampleTiming(view, table, timescale, rate);
  const sizes = sampleSizes(view, table);
  if (!sizes.length || timed !== sizes.length) throw unsupported('its frame tables disagree');
  return {
    codec,
    description,
    width,
    height,
    frameCount: sizes.length,
    offsets: sampleOffsets(view, table, sizes),
    sizes,
    keyframes: sampleKeys(view, table, sizes.length),
  };
}

/** The decode must start at the closest keyframe at or before `frame`. */
export function keyframeBefore(index: ProxyIndex, frame: number): number {
  let key = frame;
  while (key > 0 && !index.keyframes[key]) key--;
  return key;
}
