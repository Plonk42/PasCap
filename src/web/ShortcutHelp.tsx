import { useId } from 'react';
import { Modal } from './Modal.js';

const GROUPS = [
  {
    title: 'Preview',
    items: [
      ['Space', 'Play / pause'],
      ['← / →', 'Previous / next frame'],
      ['Shift + ← / →', 'Step ten frames'],
      ['Home / End', 'Go to start / end'],
    ],
  },
  {
    title: 'Timeline',
    items: [
      ['S', 'Split the selected clip at the playhead'],
      ['Q / W', 'Trim the clip start / end to the playhead'],
      ['I / O', 'Mark the start / end of a part to cut'],
      ['Shift + Delete', 'Cut the marked part'],
      ['Esc', 'Clear cut marks or cancel a drag'],
      ['Ctrl + D', 'Duplicate the selected clip'],
      ['Alt + ← / →', 'Move the selected clip one frame'],
      ['Alt + Shift + ← / →', 'Move the selected clip ten frames'],
      ['Delete / Backspace', 'Delete the selected clip'],
      ['F', 'Fit the timeline'],
      ['Drag a clip edge', 'Trim; ← / → on a focused edge trims one frame'],
      ['Drag a ◆ marker', 'Move a keyframe; ← / → on a focused marker moves one frame'],
      ['Alt while dragging', 'Ignore snapping'],
    ],
  },
  {
    title: 'Source preview',
    items: [
      ['I / O', 'Set the range IN / OUT at the displayed frame'],
      ['← / → on a range handle', 'Move it one frame (Shift: ten)'],
      ['Home / End on a range handle', 'Restore the recording start / end'],
    ],
  },
  {
    title: 'Everywhere',
    items: [
      ['Ctrl + Z', 'Undo'],
      ['Ctrl + Shift + Z / Ctrl + Y', 'Redo'],
      ['Enter / leave a field', 'Apply the typed value'],
      ['Esc in a field', 'Restore the previous value'],
      ['← / → on a pane divider', 'Resize the pane; Home or double-click restores it'],
      ['?', 'Open this help'],
    ],
  },
] as const;
export function ShortcutHelp({ onClose }: Readonly<{ onClose: () => void }>) {
  const id = useId();
  return (
    <Modal
      className="help-dialog"
      labelledBy={id}
      busy={false}
      onClose={onClose}
      footer={
        <button className="primary-button" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="activity-dialog-heading">
        <h2 id={id}>Keyboard shortcuts</h2>
      </div>
      <p className="control-hint">
        Timeline shortcuts pause while you type in a field. On macOS, use ⌘ instead of Ctrl.
      </p>
      {GROUPS.map((group) => (
        <section className="shortcut-group" key={group.title}>
          <h3>{group.title}</h3>
          <dl>
            {group.items.map(([key, meaning]) => (
              <div key={key}>
                <dt>
                  <kbd>{key}</kbd>
                </dt>
                <dd>{meaning}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Modal>
  );
}
