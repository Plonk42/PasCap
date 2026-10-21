import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import type { ProjectDocument } from '../shared/model.js';
import { musicBeatFrames, type MusicAnalysis, type PlacedBeat } from '../shared/music-analysis.js';
import { musicTracks } from '../shared/music-lanes.js';
import { musicBeatSnap, NO_BEATS } from '../shared/snap.js';
import { Icon } from './icons.js';
import { useAnalysedBeats } from './MusicAnalysis.js';
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

export type BeatSnapMode = 'off' | 'beats' | 'downbeats';
const MODES: readonly BeatSnapMode[] = ['off', 'beats', 'downbeats'];
const MODE_LABELS: Record<BeatSnapMode, string> = { off: 'Off', beats: 'Beats', downbeats: 'Downbeats only' };
const MODE_PREFERENCE = 'pascap-beat-snap';

function storedMode(): BeatSnapMode {
  const stored = readPreference(MODE_PREFERENCE);
  return MODES.find((mode) => mode === stored) ?? 'off';
}

/** Beat snapping: its mode (a browser preference) and, while Snap is on, the beats every snapping gesture uses. */
export function useBeatSnap(assets: readonly AudioAsset[], snapping: boolean) {
  const [mode, setMode] = useState<BeatSnapMode>(storedMode);
  const choose = useCallback((next: BeatSnapMode): void => {
    setMode(next);
    writePreference(MODE_PREFERENCE, next);
  }, []);
  const beatsOf = useAnalysedBeats(assets);
  const active = snapping && mode !== 'off';
  const beats = useMemo(
    () => (active ? musicBeatSnap(beatsOf, mode === 'downbeats') : NO_BEATS),
    [active, beatsOf, mode],
  );
  return { mode, choose, beatsOf, active, beats };
}

interface ControlProps {
  mode: BeatSnapMode;
  snapping: boolean;
  disabled: boolean;
  onChange: (mode: BeatSnapMode) => void;
}

/** Beside Snap: a toggle for snapping to the music's beats, and a menu choosing beats or downbeats only. */
export function BeatSnapControl({ mode, snapping, disabled, onChange }: Readonly<ControlProps>) {
  const name = useId();
  const lastOn = useRef<Exclude<BeatSnapMode, 'off'>>('beats');
  if (mode !== 'off') lastOn.current = mode;
  const on = mode !== 'off';
  const reason = snapping ? '' : 'Turn on Snap to snap to beats.';
  let title = 'Snap to the analysed beats of music clips';
  if (on) title = `Snapping to the ${mode === 'downbeats' ? 'downbeats' : 'beats'} of music clips · click to stop`;
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
        <span className="timeline-action-label">{mode === 'downbeats' ? 'Downbeats' : 'Beats'}</span>
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
            <p>Snaps to the beats of analysed music clips while Snap is on; the ruler shows them.</p>
          </div>
        )}
      </Popover>
    </fieldset>
  );
}

/** The beats snapping uses, as ticks along the bottom of the time ruler. */
export function RulerBeats({
  project,
  beatsOf,
  downbeatsOnly,
  leading,
  scale,
  width,
}: Readonly<{
  project: ProjectDocument;
  beatsOf: (mediaId: string) => MusicAnalysis['beats'] | null;
  downbeatsOnly: boolean;
  leading: number;
  scale: number;
  width: number;
}>) {
  const ticks = useMemo(() => {
    const all: BeatTicks = { beats: '', downbeats: '', beatCount: 0, downbeatCount: 0 };
    for (const music of musicTracks(project.music)) {
      const beats = beatsOf(music.mediaId);
      if (!beats) continue;
      const placed = musicBeatFrames(music, beats).filter((beat) => !downbeatsOnly || beat.downbeat);
      const clip = beatTickPaths(
        placed,
        (frame) => leading + frame * scale,
        { downbeat: 21, beat: 25, bottom: 31 },
        scale,
      );
      all.beats += clip.beats;
      all.downbeats += clip.downbeats;
      all.beatCount += clip.beatCount;
      all.downbeatCount += clip.downbeatCount;
    }
    return all;
  }, [project.music, beatsOf, downbeatsOnly, leading, scale]);
  if (!ticks.beatCount && !ticks.downbeatCount) return null;
  return (
    <svg
      className="timeline-ruler-beats"
      aria-hidden="true"
      width={width}
      height={31}
      data-beats={ticks.beatCount}
      data-downbeats={ticks.downbeatCount}
    >
      <path className="beat" d={ticks.beats} />
      <path className="downbeat" d={ticks.downbeats} />
    </svg>
  );
}
