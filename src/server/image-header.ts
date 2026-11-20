import type { ImageFormat } from '../shared/images.js';

/** Bytes read from the start of an image to find its size: past large EXIF and ICC segments. */
export const IMAGE_HEADER_BYTES = 1024 * 1024;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** JPEG start-of-frame markers, which carry the picture size (not DHT C4, JPG C8 or DAC CC). */
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
}

const be16 = (bytes: Uint8Array, at: number): number => (bytes[at]! << 8) | bytes[at + 1]!;
const be32 = (bytes: Uint8Array, at: number): number => be16(bytes, at) * 65_536 + be16(bytes, at + 2);

function pngInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 24 || String.fromCodePoint(...bytes.subarray(12, 16)) !== 'IHDR') return null;
  return { format: 'png', width: be32(bytes, 16), height: be32(bytes, 20) };
}

/** The offset of the JPEG marker after the one at `at`, or null when none can follow. */
function nextMarker(bytes: Uint8Array, at: number): number | null {
  const marker = bytes[at + 1]!;
  if (marker === 0xff) return at + 1;
  // Standalone markers carry no length.
  if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) return at + 2;
  // Scan data or the end comes before any frame header.
  if (marker === 0xd9 || marker === 0xda) return null;
  const length = be16(bytes, at + 2);
  return length < 2 ? null : at + 2 + length;
}

function jpegInfo(bytes: Uint8Array): ImageInfo | null {
  let at: number | null = 2;
  while (at !== null && at + 4 <= bytes.length && bytes[at] === 0xff) {
    if (JPEG_FRAMES.has(bytes[at + 1]!))
      return at + 9 <= bytes.length
        ? { format: 'jpeg', width: be16(bytes, at + 7), height: be16(bytes, at + 5) }
        : null;
    at = nextMarker(bytes, at);
  }
  return null;
}

/** The format and size an image's first bytes declare, or null when they are neither a JPEG nor a PNG picture. */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  let info: ImageInfo | null = null;
  if (PNG_SIGNATURE.every((value, index) => bytes[index] === value)) info = pngInfo(bytes);
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) info = jpegInfo(bytes);
  return info && info.width > 0 && info.height > 0 ? info : null;
}
