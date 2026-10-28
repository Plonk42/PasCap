import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './editor-panels.css';
import type { EditCommand } from '../shared/commands.js';
import type { ColourSettings } from '../shared/colour.js';
import type { ProjectDocument } from '../shared/model.js';
import { Icon } from './icons.js';
import { copyGradeBlocked, pasteGradeCommands, pasteTargets } from './grade-clipboard.js';
import { moveToNewTrack } from './move-to-track.js';

export interface ClipMenuAnchor {
  clipId: string;
  x: number;
  y: number;
}

interface Props {
  anchor: ClipMenuAnchor;
  onDuplicate: () => void;
  project: ProjectDocument;
  selectedClipIds: readonly string[];
  copiedGrade: ColourSettings | null;
  onCopyGrade: (colour: ColourSettings) => void;
  onEdit: (commands: readonly EditCommand[]) => void;
  onClose: (restoreFocus: boolean) => void;
}

/** Right-click (or Menu key) actions for one clip; Ctrl+D remains the keyboard shortcut. */
export function ClipContextMenu({
  anchor,
  onDuplicate,
  project,
  selectedClipIds,
  copiedGrade,
  onCopyGrade,
  onEdit,
  onClose,
}: Readonly<Props>) {
  const moved = moveToNewTrack(project, anchor.clipId);
  const moveBlocked = 'reason' in moved ? moved.reason : null;
  const clip = project.clips.find((item) => item.id === anchor.clipId);
  const copyBlocked = clip ? copyGradeBlocked(clip) : 'This clip no longer exists.';
  const targets = pasteTargets(anchor.clipId, selectedClipIds);
  const pasteBlocked = copiedGrade ? null : 'Copy a clip’s grade first.';
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
      <legend className="sr-only">Clip actions</legend>
      <button className="secondary-button small" aria-label="Duplicate selected clip" onClick={onDuplicate}>
        <Icon name="plus" size={15} />
        Duplicate <kbd>Ctrl+D</kbd>
      </button>
      <button
        className="secondary-button small"
        aria-label="Move selected clip to a new track"
        title={moveBlocked ?? 'Move this clip to a new track, so it can have its own Colour and keyframes'}
        aria-disabled={moveBlocked !== null}
        onClick={() => {
          if ('commands' in moved) {
            onClose(false);
            onEdit(moved.commands);
          }
        }}
      >
        <Icon name="layers" size={15} />
        Move to new track
      </button>
      <button
        className="secondary-button small"
        aria-label="Copy grade of this clip"
        title={copyBlocked ?? 'Copy this clip’s grade, to paste it on other clips'}
        aria-disabled={copyBlocked !== null}
        onClick={() => {
          if (!clip || copyBlocked) return;
          onCopyGrade(structuredClone(clip.grade.colour));
          onClose(true);
        }}
      >
        <Icon name="colour" size={15} />
        Copy grade
      </button>
      <button
        className="secondary-button small"
        aria-label={targets.length > 1 ? `Paste grade on ${targets.length} selected clips` : 'Paste grade on this clip'}
        title={
          pasteBlocked ??
          `Replace the grade of ${targets.length > 1 ? `these ${targets.length} clips` : 'this clip'} with the copied one, removing its keyframes`
        }
        aria-disabled={pasteBlocked !== null}
        onClick={() => {
          if (!copiedGrade) return;
          onClose(true);
          onEdit(pasteGradeCommands(project, targets, copiedGrade));
        }}
      >
        <Icon name="colour" size={15} />
        {targets.length > 1 ? `Paste grade on ${targets.length} clips` : 'Paste grade'}
      </button>
    </fieldset>
  );
}
