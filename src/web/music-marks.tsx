import type { KeyboardEvent } from 'react';
import { Icon } from './icons.js';
import { adjacentMark, musicMarkKinds, type MusicMarkKind } from './music-review-window.js';

const MARK_NAMES: Readonly<Record<MusicMarkKind, { label: string; plural: string }>> = {
  section: { label: 'Section', plural: 'sections' },
  downbeat: { label: 'Downbeat', plural: 'downbeats' },
  hit: { label: 'Strong hit', plural: 'strong hits' },
};

/** Previous/Next buttons per kind of music mark around `frame`; `where` names that frame in titles. */
export function MusicMarkJumps({
  marks,
  frame,
  where,
  disabled = false,
  onSeek,
  onKeyDown,
}: Readonly<{
  marks: Readonly<Record<MusicMarkKind, readonly number[]>>;
  frame: number;
  where: string;
  disabled?: boolean;
  onSeek: (frame: number) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
}>) {
  return musicMarkKinds.map((kind) => {
    const { label, plural } = MARK_NAMES[kind];
    const name = label.toLowerCase();
    const previous = adjacentMark(marks[kind], frame, -1);
    const next = adjacentMark(marks[kind], frame, 1);
    return (
      <fieldset key={kind} className="music-mark-jump" disabled={disabled || marks[kind].length === 0}>
        <legend className="sr-only">{`${label}s`}</legend>
        <button
          type="button"
          className="icon-button"
          aria-label={`Previous ${name}`}
          title={previous === undefined ? `No ${plural} before the ${where}` : `Go to the previous ${name}`}
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
          aria-label={`Next ${name}`}
          title={next === undefined ? `No ${plural} after the ${where}` : `Go to the next ${name}`}
          disabled={next === undefined}
          onKeyDown={onKeyDown}
          onClick={() => next !== undefined && onSeek(next)}
        >
          <Icon name="forward" size={13} />
        </button>
      </fieldset>
    );
  });
}
