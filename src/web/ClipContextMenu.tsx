import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './editor-panels.css';
import type { EditCommand } from '../shared/commands.js';
import type { ColorSettings } from '../shared/color.js';
import type { ProjectDocument } from '../shared/model.js';
import { Icon } from './icons.js';
import {
  copiedColor,
  copyGradeBlocked,
  pasteGradeCommands,
  pasteTargets,
  pasteTargetsLabel,
  type GradeTarget,
} from './grade-clipboard.js';
import { moveToNewTrack } from './move-to-track.js';

export interface ClipMenuAnchor {
  /** The right-clicked clip or adjustment. */
  target: GradeTarget;
  x: number;
  y: number;
}

interface Props {
  anchor: ClipMenuAnchor;
  onDuplicate: () => void;
  project: ProjectDocument;
  /** Every selected clip and adjustment. */
  selected: readonly GradeTarget[];
  copiedGrade: ColorSettings | null;
  onCopyGrade: (color: ColorSettings) => void;
  onEdit: (commands: readonly EditCommand[]) => void;
  onClose: (restoreFocus: boolean) => void;
}

/** Right-click (or Menu key) actions for one clip or adjustment; Ctrl+D remains the keyboard shortcut. */
export function ClipContextMenu({
  anchor,
  onDuplicate,
  project,
  selected,
  copiedGrade,
  onCopyGrade,
  onEdit,
  onClose,
}: Readonly<Props>) {
  const { target } = anchor;
  const clip = target.kind === 'clip';
  const moved = clip ? moveToNewTrack(project, target.id) : null;
  const moveBlocked = moved && 'reason' in moved ? moved.reason : null;
  const copyBlocked = copyGradeBlocked(project, target);
  const targets = pasteTargets(target, selected);
  const pasteBlocked = copiedGrade ? null : 'Copy the grade of a clip or an adjustment first.';
  const pasted = pasteTargetsLabel(targets);
  const noun = clip ? 'clip' : 'adjustment';
  const panel = useRef<HTMLFieldSetElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    element.showPopover();
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.x, innerWidth - width - 8)),
      top: Math.max(8, Math.min(anchor.y, innerHeight - height - 8)),
    });
    // The pointer's own mouseup/focus handling would otherwise take focus back.
    const focus = requestAnimationFrame(() => element.querySelector('button')?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(focus);
      if (element.matches(':popover-open')) element.hidePopover();
    };
  }, [anchor]);
  useEffect(() => {
    const outside = (event: globalThis.PointerEvent): void => {
      if (!(event.target instanceof Node && panel.current?.contains(event.target))) onClose(false);
    };
    const keyboard = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      } else if (event.key === 'Tab') onClose(false);
    };
    const dismiss = (): void => onClose(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keyboard, true);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keyboard, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [onClose]);

  return (
    <fieldset
      ref={panel}
      popover="manual"
      className="clip-context-menu"
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? 'visible' : 'hidden' }}
    >
      <legend className="sr-only">{clip ? 'Clip actions' : 'Adjustment actions'}</legend>
      {clip && (
        <>
          <button className="secondary-button small" aria-label="Duplicate selected clip" onClick={onDuplicate}>
            <Icon name="plus" size={15} />
            Duplicate <kbd>Ctrl+D</kbd>
          </button>
          <button
            className="secondary-button small"
            aria-label="Move selected clip to a new track"
            title={moveBlocked ?? 'Move this clip to a new track, with its own Transform and Opacity'}
            aria-disabled={moveBlocked !== null}
            onClick={() => {
              if (moved && 'commands' in moved) {
                onClose(false);
                onEdit(moved.commands);
              }
            }}
          >
            <Icon name="layers" size={15} />
            Move to new track
          </button>
        </>
      )}
      <button
        className="secondary-button small"
        aria-label={`Copy grade of this ${noun}`}
        title={copyBlocked ?? `Copy this ${noun}’s grade, to paste it on clips and adjustments`}
        aria-disabled={copyBlocked !== null}
        onClick={() => {
          const color = copiedColor(project, target);
          if (!color) return;
          onCopyGrade(color);
          onClose(true);
        }}
      >
        <Icon name="color" size={15} />
        Copy grade
      </button>
      <button
        className="secondary-button small"
        aria-label={`Paste grade on ${pasted}`}
        title={pasteBlocked ?? `Replace the grade of ${pasted} with the copied one, removing its keyframes`}
        aria-disabled={pasteBlocked !== null}
        onClick={() => {
          if (!copiedGrade) return;
          onClose(true);
          onEdit(pasteGradeCommands(project, targets, copiedGrade));
        }}
      >
        <Icon name="color" size={15} />
        {targets.length > 1 ? `Paste grade on ${targets.length}` : 'Paste grade'}
      </button>
    </fieldset>
  );
}
