import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import type { ProjectDocument } from '../shared/model.js';
import {
  hitBands,
  musicBeatFrames,
  musicHitFrames,
  type MusicAnalysis,
  type MusicTarget,
  type PlacedBeat,
  type PlacedHit,
} from '../shared/music-analysis.js';
import { musicTracks } from '../shared/music-lanes.js';
import { musicBeatSnap, NO_BEATS } from '../shared/snap.js';
import { Icon } from './icons.js';
import { useAnalyses } from './MusicAnalysis.js';
import { Popover } from './Popover.js';
import { readPreference, writePreference } from './preferences.js';
import './timeline-beats.css';

/** Ticks closer than this fall back to downbeats only, then to none. */
const MIN_TICK_PX = 4;

export interface BeatTicks {
  beats: string;
  downbeats: string;
  beatCount: number;
  downbeatCount: number;
}

function meanSpacing(frames: readonly number[], scale: number): number {
  return frames.length < 2 ? Infinity : ((frames.at(-1)! - frames[0]!) / (frames.length - 1)) * scale;
}

/** SVG paths of placed beats, downbeats taller; dense beats fall back to downbeats only, then to none. */
export function beatTickPaths(
  placed: readonly PlacedBeat[],
  x: (frame: number) => number,
  rows: Readonly<{ downbeat: number; beat: number; bottom: number }>,
  scale: number,
): BeatTicks {
  const showBeats =
    meanSpacing(
      placed.map((beat) => beat.frame),
      scale,
    ) >= MIN_TICK_PX;
  const showDownbeats =
    meanSpacing(
      placed.filter((beat) => beat.downbeat).map((beat) => beat.frame),
      scale,
    ) >= MIN_TICK_PX;
  const ticks: BeatTicks = { beats: '', downbeats: '', beatCount: 0, downbeatCount: 0 };
  for (const beat of placed) {
    const at = Math.round(x(beat.frame)) + 0.5;
    if (beat.downbeat && showDownbeats) {
      ticks.downbeats += `M${at} ${rows.downbeat}V${rows.bottom}`;
      ticks.downbeatCount++;
    } else if (showBeats) {
      ticks.beats += `M${at} ${rows.beat}V${rows.bottom}`;
      ticks.beatCount++;
    }
  }
  return ticks;
}

export interface HitTicks {
  /** One path per band and strength, keyed `low strong`, `mid light`, … */
  paths: { className: string; d: string }[];
  strongCount: number;
  lightCount: number;
}

/** SVG paths of placed hits by band, strong ones taller; dense hits fall back to strong ones, then to none. */
export function hitTickPaths(
  placed: readonly PlacedHit[],
  x: (frame: number) => number,
  rows: Readonly<{ strong: number; light: number; bottom: number }>,
  scale: number,
): HitTicks {
  const showLight =
    meanSpacing(
      placed.map((hit) => hit.frame),
      scale,
    ) >= MIN_TICK_PX;
  const showStrong =
    meanSpacing(
      placed.filter((hit) => hit.strong).map((hit) => hit.frame),
      scale,
    ) >= MIN_TICK_PX;
  const paths = new Map<string, string>();
  let strongCount = 0;
  let lightCount = 0;
  for (const hit of placed) {
    if (hit.strong ? !showStrong : !showLight) continue;
    const at = Math.round(x(hit.frame)) + 0.5;
    const className = `${hit.band} ${hit.strong ? 'strong' : 'light'}`;
    paths.set(className, `${paths.get(className) ?? ''}M${at} ${hit.strong ? rows.strong : rows.light}V${rows.bottom}`);
    if (hit.strong) strongCount++;
    else lightCount++;
  }
  const order = hitBands.flatMap((band) => [`${band} light`, `${band} strong`]);
  return {
    paths: order.flatMap((className) => (paths.has(className) ? [{ className, d: paths.get(className)! }] : [])),
    strongCount,
    lightCount,
  };
}

export type BeatSnapMode = 'off' | MusicTarget;
const MODES: readonly BeatSnapMode[] = ['off', 'beats', 'downbeats', 'hits', 'beats-hits'];
const MODE_LABELS: Record<BeatSnapMode, string> = {
  off: 'Off',
  beats: 'Beats',
  downbeats: 'Downbeats only',
  hits: 'Hits',
  'beats-hits': 'Beats and hits',
};
/** The toggle's label for each mode. */
const SHORT_LABELS: Record<MusicTarget, string> = {
  beats: 'Beats',
  downbeats: 'Downbeats',
  hits: 'Hits',
  'beats-hits': 'Beats + hits',
};
const TARGET_NAMES: Record<MusicTarget, string> = {
  beats: 'beats',
  downbeats: 'downbeats',
  hits: 'strong hits',
  'beats-hits': 'beats and strong hits',
};
const MODE_PREFERENCE = 'pascap-beat-snap';

function storedMode(): BeatSnapMode {
  const stored = readPreference(MODE_PREFERENCE);
  return MODES.find((mode) => mode === stored) ?? 'off';
}

/** Beat snapping: its mode (a browser preference) and, while Snap is on, the beats or hits every snapping gesture uses. */
export function useBeatSnap(assets: readonly AudioAsset[], snapping: boolean) {
  const [mode, setMode] = useState<BeatSnapMode>(storedMode);
  const choose = useCallback((next: BeatSnapMode): void => {
    setMode(next);
    writePreference(MODE_PREFERENCE, next);
  }, []);
  const analysisOf = useAnalyses(assets);
  const active = snapping && mode !== 'off';
  const beats = useMemo(() => (active ? musicBeatSnap(analysisOf, mode) : NO_BEATS), [active, analysisOf, mode]);
  return { mode, choose, analysisOf, active, beats };
}

interface ControlProps {
  mode: BeatSnapMode;
  snapping: boolean;
  disabled: boolean;
  onChange: (mode: BeatSnapMode) => void;
}

/** Beside Snap: a toggle for snapping to the music, and a menu choosing beats, downbeats only, hits or both. */
export function BeatSnapControl({ mode, snapping, disabled, onChange }: Readonly<ControlProps>) {
  const name = useId();
  const lastOn = useRef<MusicTarget>('beats');
  if (mode !== 'off') lastOn.current = mode;
  const on = mode !== 'off';
  const reason = snapping ? '' : 'Turn on Snap to snap to beats.';
  let title = 'Snap to the analysed beats of music clips';
  if (mode !== 'off') title = `Snapping to the ${TARGET_NAMES[mode]} of music clips · click to stop`;
  return (
    <fieldset className="timeline-beat-snap rush-quick-actions">
      <legend className="sr-only">Beat snapping</legend>
      <button
        type="button"
        className={`secondary-button small timeline-view-action ${on && snapping ? 'active' : ''}`}
        aria-label="Snap to beats"
        aria-pressed={on}
        aria-disabled={reason ? 'true' : undefined}
        title={reason || title}
        disabled={disabled}
        onClick={() => {
          if (!reason) onChange(on ? 'off' : lastOn.current);
        }}
      >
        <Icon name="metronome" size={15} />
        <span className="timeline-action-label">{SHORT_LABELS[lastOn.current]}</span>
      </button>
      <Popover
        label="Beat snapping options"
        className="timeline-beat-snap-menu"
        trigger={<Icon name="chevron-down" size={14} />}
      >
        {(close) => (
          <div className="timeline-beat-snap-modes">
            {MODES.map((choice) => (
              <label key={choice}>
                <input
                  type="radio"
                  name={name}
                  checked={mode === choice}
                  disabled={disabled}
                  onChange={() => {
                    onChange(choice);
                    close();
                  }}
                />
                {MODE_LABELS[choice]}
              </label>
            ))}
            <p>Snaps to the beats or strong hits of analysed music clips while Snap is on; the ruler shows them.</p>
          </div>
        )}
      </Popover>
    </fieldset>
  );
}

/** The beats and strong hits snapping uses, as ticks along the bottom of the time ruler. */
export function RulerBeats({
  project,
  analysisOf,
  target,
  leading,
  scale,
  width,
}: Readonly<{
  project: ProjectDocument;
  analysisOf: (mediaId: string) => MusicAnalysis | null;
  target: MusicTarget;
  leading: number;
  scale: number;
  width: number;
}>) {
  const ticks = useMemo(() => {
    const all: BeatTicks = { beats: '', downbeats: '', beatCount: 0, downbeatCount: 0 };
    const hits: HitTicks = { paths: [], strongCount: 0, lightCount: 0 };
    const x = (frame: number): number => leading + frame * scale;
    for (const music of musicTracks(project.music)) {
      const analysis = analysisOf(music.mediaId);
      if (!analysis) continue;
      if (target !== 'hits') {
        const placed = musicBeatFrames(music, analysis.beats).filter((beat) => target !== 'downbeats' || beat.downbeat);
        const clip = beatTickPaths(placed, x, { downbeat: 21, beat: 25, bottom: 31 }, scale);
        all.beats += clip.beats;
        all.downbeats += clip.downbeats;
        all.beatCount += clip.beatCount;
        all.downbeatCount += clip.downbeatCount;
      }
      if (target === 'hits' || target === 'beats-hits') {
        const strong = musicHitFrames(music, analysis.hits).filter((hit) => hit.strong);
        const clip = hitTickPaths(strong, x, { strong: 23, light: 23, bottom: 31 }, scale);
        hits.paths.push(...clip.paths);
        hits.strongCount += clip.strongCount;
      }
    }
    return { beats: all, hits };
  }, [project.music, analysisOf, target, leading, scale]);
  const { beats, hits } = ticks;
  if (!beats.beatCount && !beats.downbeatCount && !hits.strongCount) return null;
  return (
    <svg
      className="timeline-ruler-beats"
      aria-hidden="true"
      width={width}
      height={31}
      data-beats={beats.beatCount}
      data-downbeats={beats.downbeatCount}
      data-hits={hits.strongCount}
    >
      <path className="beat" d={beats.beats} />
      <path className="downbeat" d={beats.downbeats} />
      {hits.paths.map((path, index) => (
        <path key={`${path.className}-${index}`} className={`hit ${path.className}`} d={path.d} />
      ))}
    </svg>
  );
}
