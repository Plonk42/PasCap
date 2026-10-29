import type { Adjustment } from '../shared/grade.js';
import type { ProjectDocument } from '../shared/model.js';
import { sourceRangeForCut, type TimelineRange } from '../shared/rush-editing.js';
import type { PlacedClip } from '../shared/timeline.js';
import { formatTimecode } from '../shared/timing.js';
import { splitAdjustmentReason } from './adjustment-ui.js';
import { Icon } from './icons.js';
import './rush-editing.css';

interface Props {
  project: ProjectDocument;
  selected: PlacedClip | undefined;
  frame: number;
  disabled: boolean;
  timeRange: TimelineRange | null;
  /** Clips selected together; deleting removes them all. */
  selectedCount: number;
  /** The selected adjustment, when no clip is selected: Split and Delete act on it. */
  adjustment?: Adjustment | null;
  onSplit: () => void;
  onDelete: () => void;
  onQuickTrim: (edge: 'in' | 'out') => void;
  onCutRange: () => void;
}

function cutRangeError(project: ProjectDocument, selected: PlacedClip | undefined, range: TimelineRange | null) {
  if (!range) return 'Drag on the time ruler to select a range to cut.';
  if (!selected) return 'Select a clip to cut the selected range from it.';
  try {
    sourceRangeForCut(project, selected.clip.id, range);
    return '';
  } catch (cause) {
    return cause instanceof Error ? cause.message : 'Select a valid range.';
  }
}

export function rangeLabel(range: TimelineRange): string {
  return `${formatTimecode(range.inFrame)} – ${formatTimecode(range.outFrame)}`;
}

/** The part of the selected clip that deleting the selected range would remove. */
export function TimelineCutOverlay({
  range,
  selected,
  top,
  leading,
  scale,
}: Readonly<{
  range: TimelineRange | null;
  selected: PlacedClip | undefined;
  top: number;
  leading: number;
  scale: number;
}>) {
  if (!range || !selected) return null;
  const inFrame = Math.max(range.inFrame, selected.start);
  const outFrame = Math.min(range.outFrame, selected.end);
  if (outFrame <= inFrame) return null;
  return (
    <div
      className="timeline-cut-selection"
      data-cut-in={inFrame}
      data-cut-out={outFrame}
      style={{ top, left: leading + inFrame * scale, width: (outFrame - inFrame) * scale }}
    />
  );
}

/** Highlighted band on the time ruler, with its IN – OUT readout while it stays selected. */
export function RulerRange({
  range,
  drafting,
  leading,
  scale,
}: Readonly<{ range: TimelineRange | null; drafting: boolean; leading: number; scale: number }>) {
  if (!range) return null;
  return (
    <div
      className={`timeline-ruler-range ${drafting ? 'drafting' : ''}`}
      data-range-in={range.inFrame}
      data-range-out={range.outFrame}
      title={`Selected range ${rangeLabel(range)} (OUT exclusive)`}
      style={{ left: leading + range.inFrame * scale, width: (range.outFrame - range.inFrame) * scale }}
    >
      <span className="timeline-ruler-range-readout">{rangeLabel(range)}</span>
    </div>
  );
}

/** What Delete removes: `rangeError` is undefined without a ruler range, else its error or null. */
function deleteAction(rangeError: string | null | undefined, selectedCount: number, adjustment: boolean) {
  if (rangeError !== undefined)
    return {
      deleteName: 'Delete selected range',
      deleteTitle:
        rangeError ??
        'Remove the selected range from the selected clip in one Undo step; this track’s Ripple setting controls gap closure · Delete',
    };
  if (selectedCount > 1)
    return {
      deleteName: 'Delete selected clips',
      deleteTitle: `Remove the ${selectedCount} selected clips in one Undo step; originals remain recoverable · Delete`,
    };
  if (adjustment)
    return {
      deleteName: 'Delete selected adjustment',
      deleteTitle: 'Remove this adjustment and its keyframes · Delete',
    };
  return {
    deleteName: 'Delete selected clip',
    deleteTitle: 'Remove this clip only; originals remain recoverable · Delete',
  };
}

/** Frequently used derushing actions stay visible, not inside the rare-actions menu. */
export function RushEditBar({
  project,
  selected,
  frame,
  disabled,
  timeRange,
  selectedCount,
  adjustment,
  onSplit,
  onDelete,
  onQuickTrim,
  onCutRange,
}: Readonly<Props>) {
  const inClip = !!selected && frame >= selected.start && frame < selected.end;
  const sourceFrame = inClip ? selected.retiming.sourceAt(frame - selected.start) : null;
  const canSplit =
    sourceFrame !== null && selected !== undefined && frame > selected.start && sourceFrame > selected.clip.sourceIn;
  const splitReason = adjustment ? splitAdjustmentReason(adjustment, frame) : null;
  const canTrimIn = sourceFrame !== null && selected !== undefined && sourceFrame > selected.clip.sourceIn;
  const canTrimOut = sourceFrame !== null && selected !== undefined && sourceFrame + 1 < selected.clip.sourceOut;
  const error = cutRangeError(project, selected, timeRange);
  const { deleteName, deleteTitle } = deleteAction(
    timeRange ? error || null : undefined,
    selectedCount,
    !selected && !!adjustment,
  );

  return (
    <div className="rush-edit-bar" aria-label="Clip editing actions">
      <fieldset className="rush-quick-actions">
        <legend className="sr-only">Edit selected clip</legend>
        <button
          type="button"
          className="secondary-button small"
          aria-label="Split at playhead"
          title={
            adjustment
              ? (splitReason ?? 'Split the selected adjustment in two, each with its whole grade · S')
              : 'Split into independent clips; select the right clip · S'
          }
          disabled={disabled || (adjustment ? splitReason !== null : !canSplit)}
          onClick={onSplit}
        >
          <Icon name="split" size={15} />
          <span className="timeline-action-label">Split</span>
        </button>
        <button
          type="button"
          className="secondary-button small"
          aria-label="Trim start to playhead"
          title="Remove before the playhead, keeping the displayed source frame · Q"
          disabled={disabled || !canTrimIn}
          onClick={() => onQuickTrim('in')}
        >
          <Icon name="start" size={15} />
          <span className="timeline-action-label">Trim start</span>
        </button>
        <button
          type="button"
          className="secondary-button small"
          aria-label="Trim end to playhead"
          title="Remove after the playhead, keeping the displayed source frame · W"
          disabled={disabled || !canTrimOut}
          onClick={() => onQuickTrim('out')}
        >
          <Icon name="end" size={15} />
          <span className="timeline-action-label">Trim end</span>
        </button>
        <button
          type="button"
          className={`secondary-button small ${timeRange ? 'range-accent' : ''}`}
          aria-label={deleteName}
          title={deleteTitle}
          disabled={disabled || (timeRange ? !!error : !selected && !adjustment)}
          onClick={timeRange ? onCutRange : onDelete}
        >
          <Icon name="trash" size={15} />
          <span className="timeline-action-label">Cut</span>
        </button>
      </fieldset>
      {timeRange && (
        <output className="rush-cut-readout sr-only" aria-live="polite" title={error || 'OUT exclusive'}>
          Selected range {rangeLabel(timeRange)}
        </output>
      )}
    </div>
  );
}
