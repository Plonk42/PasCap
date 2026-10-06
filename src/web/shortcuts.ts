export type EditorShortcut =
  | {
      type:
        | 'help'
        | 'undo'
        | 'redo'
        | 'play'
        | 'split'
        | 'duplicate'
        | 'remove'
        | 'fit'
        | 'start'
        | 'end'
        | 'trim-in'
        | 'trim-out'
        | 'mark-in'
        | 'mark-out'
        | 'remove-range'
        | 'clear-range';
    }
  | { type: 'step' | 'nudge'; delta: number };
type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat'>;

function modifiedShortcut(event: ShortcutEvent): EditorShortcut | null {
  const key = event.key.toLowerCase();
  if (key === 'z') return { type: event.shiftKey ? 'redo' : 'undo' };
  if (key === 'd') return { type: 'duplicate' };
  return key === 'y' ? { type: 'redo' } : null;
}

function arrowShortcut(event: ShortcutEvent): EditorShortcut {
  return {
    type: event.altKey ? 'nudge' : 'step',
    delta: (event.key.toLowerCase() === 'arrowleft' ? -1 : 1) * (event.shiftKey ? 10 : 1),
  };
}

/** Target/modal guards belong to the shell; this mapping never edits a document. */
export function editorShortcut(event: ShortcutEvent, nativeSpace = false): EditorShortcut | null {
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) return modifiedShortcut(event);
  if (['arrowleft', 'arrowright'].includes(key)) return arrowShortcut(event);
  if (event.altKey) return null;
  if (key === '?') return { type: 'help' };
  if (event.code === 'Space') return nativeSpace || event.repeat ? null : { type: 'play' };
  if (event.shiftKey && ['delete', 'backspace'].includes(key)) return { type: 'remove-range' };
  const actions: Readonly<Record<string, EditorShortcut['type']>> = {
    s: 'split',
    q: 'trim-in',
    w: 'trim-out',
    i: 'mark-in',
    o: 'mark-out',
    escape: 'clear-range',
    f: 'fit',
    home: 'start',
    end: 'end',
    delete: 'remove',
    backspace: 'remove',
  };
  const type = actions[key];
  return type && type !== 'step' && type !== 'nudge' ? { type } : null;
}
