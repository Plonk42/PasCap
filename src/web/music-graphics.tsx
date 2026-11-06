import { useMemo } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import type { MusicTrack } from '../shared/model.js';
import { musicBeatFrames, musicHitFrames, type MusicAnalysis } from '../shared/music-analysis.js';
import { waveformColumnCount, waveformColumns } from '../shared/waveform.js';
import { useMusicAnalysis } from './MusicAnalysis.js';
import { MusicStructure } from './music-structure.js';
import { useWaveform, waveformPath } from './music-waveform.js';
import { beatTickPaths, hitTickPaths, type BeatTicks, type HitTicks } from './timeline-beats.js';

/** Hit marks end just above the tone strip, light ones half as tall as strong ones. */
const HIT_ROWS = { strong: 50, light: 56, bottom: 62 } as const;

/** SVG paths of a music clip's hits within its clip, at the clip's scale. */
function hitTicks(music: MusicTrack, hits: MusicAnalysis['hits'] | null, scale: number): HitTicks | null {
  if (!hits?.length) return null;
  return hitTickPaths(musicHitFrames(music, hits), (frame) => (frame - music.start) * scale, HIT_ROWS, scale);
}

/** SVG paths of a music track's beats within its clip, at the clip's scale. */
function beatTicks(music: MusicTrack, beats: MusicAnalysis['beats'] | null, scale: number): BeatTicks | null {
  if (!beats?.length) return null;
  return beatTickPaths(
    musicBeatFrames(music, beats),
    (frame) => (frame - music.start) * scale,
    { downbeat: 26, beat: 36, bottom: 46 },
    scale,
  );
}

/** A music clip's structure, waveform, beats and hits as it plays, `scale` pixels per frame. */
export function MusicGraphics({
  music,
  asset,
  scale,
  label,
}: Readonly<{ music: MusicTrack; asset: AudioAsset | undefined; scale: number; label: string }>) {
  const { phase } = useMusicAnalysis(asset);
  const analyzed = phase.kind === 'ready' ? phase.analysis : null;
  const ticks = useMemo(() => beatTicks(music, analyzed?.beats ?? null, scale), [music, analyzed, scale]);
  const hitMarks = useMemo(() => hitTicks(music, analyzed?.hits ?? null, scale), [music, analyzed, scale]);
  const structure = useMemo(
    () => analyzed && <MusicStructure music={music} analysis={analyzed} scale={scale} />,
    [music, analyzed, scale],
  );
  const wave = useWaveform(asset);
  const columns = wave ? waveformColumnCount(wave, music.duration, music.duration * scale) : 0;
  const { sourceIn, sourceOut, duration, loop } = music;
  const outline = useMemo(
    () => (wave ? waveformPath(waveformColumns(wave, { sourceIn, sourceOut, duration, loop }, columns)) : null),
    [wave, sourceIn, sourceOut, duration, loop, columns],
  );
  return (
    <>
      {structure}
      <svg
        className="music-waveform"
        viewBox={`0 0 ${Math.max(1, columns)} 45`}
        preserveAspectRatio="none"
        aria-label={`Waveform for ${label}`}
        role="img"
      >
        {outline && <path d={outline} fill="#acb8ee" />}
      </svg>
      {ticks && (
        <svg
          className="music-beats"
          aria-hidden="true"
          data-beats={ticks.beatCount}
          data-downbeats={ticks.downbeatCount}
        >
          <path className="beat" d={ticks.beats} />
          <path className="downbeat" d={ticks.downbeats} />
        </svg>
      )}
      {hitMarks && (
        <svg
          className="music-hits"
          aria-hidden="true"
          data-strong-hits={hitMarks.strongCount}
          data-light-hits={hitMarks.lightCount}
        >
          {hitMarks.paths.map((path) => (
            <path key={path.className} className={path.className} d={path.d} />
          ))}
        </svg>
      )}
    </>
  );
}
