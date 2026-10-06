import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPreference, writePreference } from '../../src/web/preferences.js';

afterEach(() => vi.unstubAllGlobals());
describe('editor-only browser preferences', () => {
  it('reads/writes only the requested UI key', () => {
    const getItem = vi.fn(() => 'open');
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem, setItem });
    expect(readPreference('section')).toBe('open');
    expect(getItem).toHaveBeenCalledWith('section');
    expect(writePreference('section', 'closed')).toBe(true);
    expect(setItem).toHaveBeenCalledWith('section', 'closed');
  });
  it('does not crash a workspace when preference reads/writes are denied', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('Storage denied');
      },
      setItem: () => {
        throw new Error('Quota exceeded');
      },
    });
    expect(readPreference('section')).toBeNull();
    expect(writePreference('section', 'closed')).toBe(false);
  });
});
