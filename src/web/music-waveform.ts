import { useEffect, useMemo, useState } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import { MUSIC_SAMPLES_PER_FRAME } from '../shared/music-format.js';
import { coarseWaveform, decodeWaveform, type WaveformColumns, type WaveformLevels } from '../shared/waveform.js';
import { callOperation } from './operations.js';

/** One read per prepared recording, shared by all its music clips; a failed read is tried again later. */
const details = new Map<string, Promise<WaveformLevels>>();

function readDetail(key: string, id: string): Promise<WaveformLevels> {
  let read = details.get(key);
  if (!read) {
    read = callOperation('music_waveform', { mediaId: id }).then(({ bucketSamples, data }) =>
      decodeWaveform(data, bucketSamples),
    );
    details.set(key, read);
    read.catch(() => details.delete(key));
  }
  return read;
}

/** The level of a prepared recording: its stored peaks at once, then every 10 ms once the service has read them. */
export function useWaveform(asset: AudioAsset | undefined): WaveformLevels | null {
  const ready = asset?.status === 'ready';
  const id = asset?.id ?? '';
  const key = `${id}/${asset?.content?.digest ?? ''}`;
  const [detail, setDetail] = useState<{ key: string; wave: WaveformLevels } | null>(null);
  useEffect(() => {
    if (!ready) return;
    let current = true;
    readDetail(key, id).then(
      (wave) => {
        if (current) setDetail({ key, wave });
      },
      () => {
        // The stored peaks stay drawn.
      },
    );
    return () => {
      current = false;
    };
  }, [ready, key, id]);
  const frames = asset?.metadata.frameCount ?? 0;
  const peaks = asset?.waveform;
  const coarse = useMemo(
    () => (ready && peaks ? coarseWaveform(peaks, frames * MUSIC_SAMPLES_PER_FRAME) : null),
    [ready, peaks, frames],
  );
  return detail?.key === key ? detail.wave : coarse;
}

const CENTRE = 22;
const HALF = 20;
/** The least height of a column in drawing units, so silence stays a visible line. */
const LEAST = 1.5;

/** One outline around every column, in drawing units of one per column across and 45 high. */
export function waveformPath({ min, max }: WaveformColumns): string {
  const count = max.length;
  const top = new Array<number>(count);
  const bottom = new Array<number>(count);
  for (let column = 0; column < count; column++) {
    let upper = CENTRE - max[column]! * HALF;
    let lower = CENTRE - min[column]! * HALF;
    if (lower - upper < LEAST) {
      const middle = (upper + lower) / 2;
      upper = middle - LEAST / 2;
      lower = middle + LEAST / 2;
    }
    top[column] = Math.round(upper * 10) / 10;
    bottom[column] = Math.round(lower * 10) / 10;
  }
  const parts = [`M0 ${top[0]}`];
  for (let column = 0; column < count; column++) {
    if (column > 0 && top[column] !== top[column - 1]) parts.push(`V${top[column]}`);
    parts.push(`H${column + 1}`);
  }
  for (let column = count - 1; column >= 0; column--) {
    if (column === count - 1 || bottom[column] !== bottom[column + 1]) parts.push(`V${bottom[column]}`);
    parts.push(`H${column}`);
  }
  return `${parts.join('')}Z`;
}
