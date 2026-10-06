import { describe, expect, it } from 'vitest';
import { editorShortcut } from '../../src/web/shortcuts.js';

const base = { key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false };
describe('editor shortcut mapping', () => {
  it.each([
    ['?', 'help'],
    ['s', 'split'],
    ['S', 'split'],
    ['f', 'fit'],
    ['Home', 'start'],
    ['End', 'end'],
    ['Delete', 'remove'],
    ['Backspace', 'remove'],
  ])('maps %s without changing a document', (key, type) => {
    expect(editorShortcut({ ...base, key })).toEqual({ type });
  });
  it('supports both Ctrl and Meta histories without treating modifier typing as edits', () => {
    for (const modifier of ['ctrlKey', 'metaKey'] as const) {
      expect(editorShortcut({ ...base, key: 'z', [modifier]: true })).toEqual({ type: 'undo' });
      expect(editorShortcut({ ...base, key: 'z', [modifier]: true, shiftKey: true })).toEqual({ type: 'redo' });
      expect(editorShortcut({ ...base, key: 'y', [modifier]: true })).toEqual({ type: 'redo' });
      expect(editorShortcut({ ...base, key: 'd', [modifier]: true })).toEqual({ type: 'duplicate' });
      expect(editorShortcut({ ...base, key: 's', [modifier]: true })).toBeNull();
    }
  });
  it('does not swallow a focused button Space or repeatedly toggle on a held Space', () => {
    expect(editorShortcut({ ...base, key: ' ', code: 'Space' })).toEqual({ type: 'play' });
    expect(editorShortcut({ ...base, key: ' ', code: 'Space' }, true)).toBeNull();
    expect(editorShortcut({ ...base, key: ' ', code: 'Space', repeat: true })).toBeNull();
  });
  it('maps exact one/ten-frame steps and leaves Alt or unrecognized keys alone', () => {
    expect(editorShortcut({ ...base, key: 'ArrowLeft' })).toEqual({ type: 'step', delta: -1 });
    expect(editorShortcut({ ...base, key: 'ArrowRight', shiftKey: true })).toEqual({ type: 'step', delta: 10 });
    expect(editorShortcut({ ...base, key: 'ArrowLeft', shiftKey: true })).toEqual({ type: 'step', delta: -10 });
    expect(editorShortcut({ ...base, key: 'ArrowLeft', altKey: true })).toEqual({ type: 'nudge', delta: -1 });
    expect(editorShortcut({ ...base, key: 'ArrowRight', altKey: true, shiftKey: true })).toEqual({
      type: 'nudge',
      delta: 10,
    });
    expect(editorShortcut({ ...base, key: 'Delete', altKey: true })).toBeNull();
    expect(editorShortcut({ ...base, key: 'Escape' })).toEqual({ type: 'clear-range' });
  });
  it.each([
    ['q', 'trim-in'],
    ['w', 'trim-out'],
    ['i', 'mark-in'],
    ['o', 'mark-out'],
  ])('maps rush edit %s without interfering with modifiers', (key, type) => {
    expect(editorShortcut({ ...base, key })).toEqual({ type });
    expect(editorShortcut({ ...base, key, ctrlKey: true })).toBeNull();
    expect(editorShortcut({ ...base, key, altKey: true })).toBeNull();
  });
  it('distinguishes cutting a marked part from deleting an entire excerpt', () => {
    expect(editorShortcut({ ...base, key: 'Delete', shiftKey: true })).toEqual({ type: 'remove-range' });
    expect(editorShortcut({ ...base, key: 'Backspace', shiftKey: true })).toEqual({ type: 'remove-range' });
    expect(editorShortcut({ ...base, key: 'Delete' })).toEqual({ type: 'remove' });
  });
});
