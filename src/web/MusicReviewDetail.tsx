import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AudioAsset } from '../shared/audio.js';
import type { MediaSelection } from '../shared/media-selection.js';
import type { MusicTrack } from '../shared/model.js';
import type { MusicAnalysis } from '../shared/music-analysis.js';
import { formatTimecode } from '../shared/timing.js';
import { Icon } from './icons.js';
import { MusicGraphics } from './music-graphics.js';
import {
  adjacentMark,
  DETAIL_SECONDS,
  musicMarks,
  windowTrack,
  type DetailWindow,
  type MusicMarkKind,
} from './music-review-window.js';

interface DetailProps {
  asset: AudioAsset;
  view: DetailWindow;
  frame: number;
  range: MediaSelection;
  onSeek: (frame: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/** A few seconds of the recording around its play position, wide enough to read its beats and hits. */
export function MusicReviewDetail({ asset, view, frame, range, onSeek, onKeyDown }: Readonly<DetailProps>) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  const { start, length } = view;
  const track = useMemo(() => windowTrack(asset.id, { start, length }), [asset.id, start, length]);
  const end = start + length;
  const percent = (value: number): string => `${((Math.min(end, Math.max(start, value)) - start) / length) * 100}%`;
  return (
    <div
      className="music-review-detail"
      ref={host}
      data-window-start={start}
      data-window-end={end}
      data-source-in={range.sourceIn}
      data-source-out={range.sourceOut}
    >
      {size.width > 0 && size.height > 0 && (
        <div className="music-body music-review-body">
          <MusicGraphics
            music={track}
            asset={asset}
            scale={size.width / length}
            height={size.height}
            label={`${asset.name}, zoomed`}
          />
        </div>
      )}
      {range.sourceIn > start && (
        <span className="source-range-omitted before" style={{ width: percent(range.sourceIn) }} aria-hidden="true" />
      )}
      {range.sourceOut < end && (
        <span
          className="source-range-omitted after"
          style={{ left: percent(range.sourceOut), right: 0 }}
          aria-hidden="true"
        />
      )}
      {(['in', 'out'] as const).map((edge) => {
        const value = edge === 'in' ? range.sourceIn : range.sourceOut;
        return (
          value >= start &&
          value <= end && (
            <span
              key={edge}
              className={`music-review-edge ${edge}`}
              style={{ left: percent(value) }}
              aria-hidden="true"
            >
              {edge === 'in' ? 'IN' : 'OUT'}
            </span>
          )
        );
      })}
      <input
        className="source-playhead-input"
        type="range"
        aria-label="Zoomed music playhead"
        title="Click or drag to move the play position; I marks IN, O marks OUT"
        min={start}
        max={end - 1}
        step={1}
        value={frame}
        aria-valuetext={`Music frame ${frame}, ${formatTimecode(frame)}`}
        onKeyDown={onKeyDown}
        onChange={(event) => onSeek(Number(event.target.value))}
      />
      <span
        className="music-review-head"
        style={{ left: `${length === 1 ? 0 : ((frame - start) / (length - 1)) * 100}%` }}
        aria-hidden="true"
      />
    </div>
  );
}

const MARK_NAMES: Readonly<Record<MusicMarkKind, { label: string; plural: string }>> = {
  section: { label: 'Section', plural: 'sections' },
  downbeat: { label: 'Downbeat', plural: 'downbeats' },
  hit: { label: 'Strong hit', plural: 'strong hits' },
};

interface MarksProps {
  whole: MusicTrack;
  analysis: MusicAnalysis | null;
  frame: number;
  seconds: number;
  onSeek: (frame: number) => void;
  onZoom: (seconds: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

/** Previous/Next per kind of mark, and the zoomed view's length. */
export function MusicReviewMarks({ whole, analysis, frame, seconds, onSeek, onZoom, onKeyDown }: Readonly<MarksProps>) {
  const marks = useMemo(() => (analysis ? musicMarks(whole, analysis) : null), [whole, analysis]);
  const zoom = DETAIL_SECONDS.indexOf(seconds as (typeof DETAIL_SECONDS)[number]);
  return (
    <div className="music-review-marks">
      {marks &&
        (Object.keys(MARK_NAMES) as MusicMarkKind[]).map((kind) => {
          const { label, plural } = MARK_NAMES[kind];
          const previous = adjacentMark(marks[kind], frame, -1);
          const next = adjacentMark(marks[kind], frame, 1);
          return (
            <fieldset key={kind} className="music-review-jump" disabled={marks[kind].length === 0}>
              <legend className="sr-only">{`${label}s`}</legend>
              <button
                type="button"
                className="icon-button"
                aria-label={`Previous ${label.toLowerCase()}`}
                title={
                  previous === undefined
                    ? `No ${plural} before the play position`
                    : `Go to the previous ${label.toLowerCase()}`
                }
                disabled={previous === undefined}
                onKeyDown={onKeyDown}
                onClick={() => previous !== undefined && onSeek(previous)}
              >
                <Icon name="back" size={13} />
              </button>
              <span title={`${marks[kind].length} ${plural}`}>{label}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Next ${label.toLowerCase()}`}
                title={
                  next === undefined ? `No ${plural} after the play position` : `Go to the next ${label.toLowerCase()}`
                }
                disabled={next === undefined}
                onKeyDown={onKeyDown}
                onClick={() => next !== undefined && onSeek(next)}
              >
                <Icon name="forward" size={13} />
              </button>
            </fieldset>
          );
        })}
      <fieldset className="music-review-zoom">
        <legend className="sr-only">Zoom</legend>
        <button
          type="button"
          className="icon-button"
          aria-label="Zoom out music"
          title="Show more of the recording around the play position"
          disabled={zoom >= DETAIL_SECONDS.length - 1}
          onKeyDown={onKeyDown}
          onClick={() => onZoom(DETAIL_SECONDS[zoom + 1]!)}
        >
          <Icon name="minus" size={13} />
        </button>
        <span title="Length of the zoomed view">{seconds} s</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Zoom in music"
          title="Show less of the recording, in more detail"
          disabled={zoom <= 0}
          onKeyDown={onKeyDown}
          onClick={() => onZoom(DETAIL_SECONDS[zoom - 1]!)}
        >
          <Icon name="plus" size={13} />
        </button>
      </fieldset>
    </div>
  );
}
