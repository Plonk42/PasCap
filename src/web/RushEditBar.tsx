import type { ProjectDocument } from '../shared/model.js';
import { sourceRangeForCut, type ClipCutRange } from '../shared/rush-editing.js';
import type { PlacedClip } from '../shared/timeline.js';
import { formatTimecode } from '../shared/timing.js';
import { Icon } from './icons.js';
import './rush-editing.css';

interface Props {
  project: ProjectDocument;
  selected: PlacedClip | undefined;
  frame: number;
  disabled: boolean;
  cutRange: ClipCutRange | null;
  onSplit: () => void;
  onDelete: () => void;
  onQuickTrim: (edge: 'in' | 'out') => void;
  onMarkCut: (edge: 'in' | 'out') => void;
  onCutMarked: () => void;
  onClearCut: () => void;
}

function markedCutError(project: ProjectDocument, marks: ClipCutRange | null): string {
  if (!marks) return 'Mark IN and OUT within one excerpt to remove an unwanted part.';
  try { sourceRangeForCut(project, marks); return ''; }
  catch (cause) { return cause instanceof Error ? cause.message : 'Choose valid IN and OUT marks.'; }
}

export function TimelineCutMarks({ marks, selected, top, leading, scale }: Readonly<{ marks: ClipCutRange | null; selected: PlacedClip | undefined; top: number; leading: number; scale: number }>) {
  if (!marks) return null;
  if (marks.clipId !== selected?.clip.id) return null;
  return <>
    {marks.inFrame !== null && marks.outFrame !== null && marks.outFrame > marks.inFrame && <div className="timeline-cut-selection" data-cut-in={marks.inFrame} data-cut-out={marks.outFrame} style={{ top, left: leading + marks.inFrame * scale, width: (marks.outFrame - marks.inFrame) * scale }} />}
    {(['in', 'out'] as const).map((edge) => {
      const position = edge === 'in' ? marks.inFrame : marks.outFrame;
      return position === null ? null : <div className="timeline-cut-mark" key={edge} style={{ top: top - 3, left: leading + position * scale }}><span>{edge.toUpperCase()}</span></div>;
    })}
  </>;
}

/** Frequently used derushing actions stay visible, not inside the rare-actions menu. */
export function RushEditBar({ project, selected, frame, disabled, cutRange, onSplit, onDelete, onQuickTrim, onMarkCut, onCutMarked, onClearCut }: Readonly<Props>) {
  const inClip = !!selected && frame >= selected.start && frame < selected.end;
  const sourceFrame = inClip ? selected.retiming.sourceAt(frame - selected.start) : null;
  const canSplit = sourceFrame !== null && selected !== undefined && frame > selected.start && sourceFrame > selected.clip.sourceIn;
  const canTrimIn = sourceFrame !== null && selected !== undefined && sourceFrame > selected.clip.sourceIn;
  const canTrimOut = sourceFrame !== null && selected !== undefined && sourceFrame + 1 < selected.clip.sourceOut;
  const marks = cutRange?.clipId === selected?.clip.id ? cutRange : null;
  const error = markedCutError(project, marks);
  const ripple = !selected || selected.clip.layerId === project.layers[0]!.id;
  const mode = ripple ? 'Ripple sequence' : 'Positioned overlay';
  const modeHint = ripple ? 'Trim, cut, delete or reorder: later primary excerpts close up automatically. Their order and source ranges are kept.' : 'Overlay edits keep other clips at their absolute positions. Use the primary row for automatic ripple sequencing.';

  return <div className="rush-edit-bar" aria-label="Rush editing actions">
    <span className={`rush-edit-mode ${ripple ? 'ripple' : ''}`} title={modeHint}>{mode}</span>
    <div className="rush-quick-actions">
      <button type="button" className="secondary-button small" aria-label="Split at playhead" title="Split into independent excerpts; select the right piece · S" disabled={disabled || !canSplit} onClick={onSplit}><Icon name="split" size={14} />Split</button>
      <button type="button" className="secondary-button small" aria-label="Trim start to playhead" title="Remove before the playhead, keeping the displayed source frame · Q" disabled={disabled || !canTrimIn} onClick={() => onQuickTrim('in')}><Icon name="start" size={13} />Trim start</button>
      <button type="button" className="secondary-button small" aria-label="Trim end to playhead" title="Remove after the playhead, keeping the displayed source frame · W" disabled={disabled || !canTrimOut} onClick={() => onQuickTrim('out')}><Icon name="end" size={13} />Trim end</button>
      <button type="button" className="icon-button" aria-label="Delete selected clip" title="Remove this excerpt only; originals remain recoverable · Delete" disabled={disabled || !selected} onClick={onDelete}><Icon name="trash" size={15} /></button>
    </div>
    <div className="rush-cut-actions">
      <button type="button" className={`secondary-button small ${marks?.inFrame !== null && marks?.inFrame !== undefined ? 'active' : ''}`} aria-label="Mark cut IN" title="Start the unwanted part here · I" disabled={disabled || !inClip} onClick={() => onMarkCut('in')}>IN</button>
      <button type="button" className={`secondary-button small ${marks?.outFrame !== null && marks?.outFrame !== undefined ? 'active' : ''}`} aria-label="Mark cut OUT" title="End the unwanted part after this frame (OUT exclusive) · O" disabled={disabled || !inClip} onClick={() => onMarkCut('out')}>OUT</button>
      <button type="button" className="secondary-button small rush-cut-button" aria-label="Cut marked range" title={error || 'Remove the marked part in one undoable edit; retained excerpts stay connected on the primary row · Shift+Delete'} disabled={disabled || !!error} onClick={onCutMarked}>Cut range</button>
      {marks && <button type="button" className="icon-button" aria-label="Clear cut marks" title="Clear temporary marks · Escape" onClick={onClearCut}><Icon name="x" size={13} /></button>}
    </div>
    {marks && <output className="rush-cut-readout" aria-live="polite" title={error || 'Timeline marks; OUT exclusive'}>{marks.inFrame === null ? 'IN —' : `IN ${formatTimecode(marks.inFrame)}`} → {marks.outFrame === null ? 'OUT —' : `OUT ${formatTimecode(marks.outFrame)}`}</output>}
  </div>;
}