import { describe, expect, it } from 'vitest';
import { nativeThreadCount } from '../../src/server/native-threads.js';

describe('nativeThreadCount', () => {
  it.each([
    [1, 2],
    [2, 2],
    [4, 2],
    [8, 4],
    [12, 6],
    [16, 8],
    [64, 8],
  ])('uses half of %i cores, bounded 2-8 (%i)', (cores, expected) => {
    expect(nativeThreadCount(cores)).toBe(expected);
  });
});
