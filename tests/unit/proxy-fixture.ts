/** Synthetic ISO-BMFF editing proxies for index and reader tests: real box layout, fake H.264 samples. */
export interface ProxyFixtureOptions {
  frames?: number;
  gop?: number;
  timescale?: number;
  delta?: number;
  editMediaTime?: number | null;
  reordered?: boolean;
  sampleEntry?: string;
  videoTracks?: number;
  indexFirst?: boolean;
  firstKey?: boolean;
  wide?: boolean;
}
export interface ProxyFixture {
  bytes: Uint8Array<ArrayBuffer>;
  offsets: number[];
  sizes: number[];
}

const encoder = new TextEncoder();
function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}
function u64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
}
function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value);
  return bytes;
}
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(...parts);
  return concat(u32(8 + body.length), encoder.encode(type), body);
}
function full(type: string, ...parts: Uint8Array[]): Uint8Array {
  return box(type, u32(0), ...parts);
}
function table(type: string, entries: readonly (readonly number[])[]): Uint8Array {
  return full(type, u32(entries.length), ...entries.flatMap((entry) => entry.map(u32)));
}

export function sampleSize(frame: number): number {
  return 100 + (frame % 7) * 10;
}

export function buildProxy(options: ProxyFixtureOptions = {}): ProxyFixture {
  const frames = options.frames ?? 60;
  const gop = options.gop ?? 15;
  const sizes = Array.from({ length: frames }, (_value, frame) => sampleSize(frame));
  const keys = Array.from({ length: frames }, (_value, frame) => frame).filter(
    (frame) => frame % gop === 0 && (frame > 0 || options.firstKey !== false),
  );
  const chunk = 5;
  const chunks = Math.ceil(frames / chunk);
  const track = (offsets: readonly number[], handler: string): Uint8Array => {
    const runs: number[][] = [[1, chunk, 1]];
    if (frames % chunk) runs.push([chunks, frames % chunk, 1]);
    const entry = box(
      options.sampleEntry ?? 'avc1',
      new Uint8Array(24),
      u16(1280),
      u16(720),
      new Uint8Array(50),
      box('avcC', new Uint8Array([1, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0, 0])),
    );
    const chunkOffsets = Array.from({ length: chunks }, (_value, index) => offsets[index * chunk]!);
    const stbl = box(
      'stbl',
      full('stsd', u32(1), entry),
      table('stts', [[frames, options.delta ?? 1001]]),
      ...(options.reordered ? [table('ctts', [[frames, 0]])] : []),
      table(
        'stss',
        keys.map((key) => [key + 1]),
      ),
      table('stsc', runs),
      full('stsz', u32(0), u32(frames), ...sizes.map(u32)),
      options.wide
        ? full('co64', u32(chunks), ...chunkOffsets.map(u64))
        : table(
            'stco',
            chunkOffsets.map((offset) => [offset]),
          ),
    );
    const edit =
      options.editMediaTime === null
        ? []
        : [box('edts', table('elst', [[frames * 1001, options.editMediaTime ?? 0, 0x10000]]))];
    return box(
      'trak',
      full('tkhd', new Uint8Array(80)),
      ...edit,
      box(
        'mdia',
        full('mdhd', u32(0), u32(0), u32(options.timescale ?? 30_000), u32(frames * 1001), u32(0)),
        full('hdlr', u32(0), encoder.encode(handler), new Uint8Array(13)),
        box('minf', full('vmhd', new Uint8Array(4)), stbl),
      ),
    );
  };
  const moov = (offsets: readonly number[]): Uint8Array =>
    box(
      'moov',
      full('mvhd', new Uint8Array(96)),
      ...Array.from({ length: options.videoTracks ?? 1 }, () => track(offsets, 'vide')),
    );
  const ftyp = box('ftyp', encoder.encode('isom'), u32(0x200), encoder.encode('isomavc1'));
  const media = box('mdat', ...sizes.map((size, frame) => new Uint8Array(size).fill(frame & 0xff)));
  const indexLength = moov(sizes.map(() => 0)).length;
  const offsets: number[] = [];
  let offset = (options.indexFirst === false ? ftyp.length : ftyp.length + indexLength) + 8;
  for (const size of sizes) {
    offsets.push(offset);
    offset += size;
  }
  const index = moov(offsets);
  const bytes = options.indexFirst === false ? concat(ftyp, media, index) : concat(ftyp, index, media);
  return { bytes, offsets, sizes };
}
