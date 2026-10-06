import { describe, expect, it } from 'vitest';
import { parseTimecode } from '../../src/web/TimecodeField.js';
import { clampSize, DEFAULT_LAYOUT, validLayout, workspaceSizes } from '../../src/web/workspace.js';

describe('workspace bounds remain editor-only and fit desktop sizes', () => {
  it('validates complete preferences and rejects non-finite/malformed sizes', () => {
    expect(validLayout(DEFAULT_LAYOUT)).toBe(true);
    for (const value of [
      null,
      {},
      { ...DEFAULT_LAYOUT, mediaWidth: Number.NaN },
      { ...DEFAULT_LAYOUT, timelineHeight: 700 },
      { ...DEFAULT_LAYOUT, mediaOpen: 'yes' },
    ])
      expect(validLayout(value)).toBe(false);
  });
  it.each([
    [1024, 680],
    [1280, 720],
    [1440, 900],
    [1920, 1080],
  ])('bounds pane and timeline sizes at %s × %s', (width, height) => {
    const result = workspaceSizes(
      { ...DEFAULT_LAYOUT, mediaWidth: 600, inspectorWidth: 600, timelineHeight: 600 },
      width,
      height,
    );
    expect(result.media).toBeLessThanOrEqual(width * 0.29);
    expect(result.inspector).toBeLessThanOrEqual(Math.max(270, width * 0.3));
    expect(result.timeline).toBeLessThanOrEqual(height - 360);
    expect(result.media).toBeGreaterThanOrEqual(240);
    expect(result.inspector).toBeGreaterThanOrEqual(270);
  });
  it('clamps and rounds UI pixels, never project frames', () => {
    expect(clampSize(280.6, 240, 440)).toBe(281);
    expect(clampSize(-20, 240, 440)).toBe(240);
    expect(clampSize(999, 240, 440)).toBe(440);
  });
});
describe('editable non-drop-frame timecode', () => {
  it.each([
    ['00:00:00:00', 0],
    ['00:00:01:00', 30],
    ['00:01:00:29', 1829],
    ['01:00:00:00', 108000],
    [' 165 ', 165],
  ])('parses %s to exact nominal frame %s', (value, frame) => {
    expect(parseTimecode(value, 200_000)).toEqual({ frame });
  });
  it.each(['', '1.5', '-1', '00:60:00:00', '00:00:60:00', '00:00:01:30', '01:00', 'garbage'])(
    'rejects invalid timecode %s',
    (value) => {
      expect(parseTimecode(value, 200)).toHaveProperty('error');
    },
  );
  it('rejects the exclusive project end and an empty timeline', () => {
    expect(parseTimecode('200', 200)).toHaveProperty('error');
    expect(parseTimecode('0', 0)).toHaveProperty('error');
    expect(parseTimecode('199', 200)).toEqual({ frame: 199 });
  });
});
