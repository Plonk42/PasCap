import { useId } from 'react';
import { Modal } from './Modal.js';

const GROUPS = [
  { title: 'Playback & navigation', items: [['Space', 'Play / pause timeline'], ['← / →', 'Previous / next frame'], ['Shift + ← / →', 'Step ten frames'], ['Home / End', 'Timeline start / end'], ['F', 'Fit timeline'], ['?', 'Open this help']] },
  { title: 'Editing', items: [['S', 'Split; continue with the right excerpt selected'], ['Q / W', 'Trim before / after playhead; retain the displayed frame'], ['I / O in timeline', 'Mark an unwanted part within the selected excerpt'], ['Shift + Delete', 'Cut the marked part; the primary sequence closes up'], ['Esc in timeline', 'Clear cut marks / cancel pointer draft'], ['Ctrl + D', 'Duplicate the selected excerpt'], ['Alt + ← / →', 'Move an overlay one frame earlier / later'], ['Alt + Shift + ← / →', 'Move an overlay ten frames'], ['Delete / Backspace', 'Remove selected excerpt (undoable)'], ['Ctrl + Z', 'Undo'], ['Ctrl + Shift + Z / Ctrl + Y', 'Redo'], ['Enter / blur', 'Apply a numeric or title field'], ['Esc in a field', 'Restore its draft']] },
  { title: 'Source review & trimming', items: [['I / O', 'Mark source IN / exclusive OUT in source review'], ['← / → on an edge', 'Trim / restore one original frame'], ['Shift + arrow on an edge', 'Trim / restore ten frames'], ['Home on left edge', 'Restore original IN'], ['End on right edge', 'Restore original OUT'], ['Alt while dragging', 'Bypass timeline snapping']] },
] as const;
export function ShortcutHelp({ onClose }: Readonly<{ onClose: () => void }>) {
  const id = useId();
  return <Modal className="help-dialog" labelledBy={id} busy={false} onClose={onClose} footer={<button className="primary-button" onClick={onClose}>Done</button>}>
    <div className="activity-dialog-heading"><h2 id={id}>Keyboard shortcuts</h2></div>
    <p className="control-hint">Editing shortcuts do not run while typing, reviewing a source, or using a modal. On macOS, use ⌘ instead of Ctrl.</p>
    {GROUPS.map((group) => <section className="shortcut-group" key={group.title}><h3>{group.title}</h3><dl>{group.items.map(([key, meaning]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{meaning}</dd></div>)}</dl></section>)}
    <p className="control-hint">Drag pane dividers to resize. Arrow keys adjust a focused divider; double-click or Home restores its default size. Workspace preferences do not change a project.</p>
  </Modal>;
}