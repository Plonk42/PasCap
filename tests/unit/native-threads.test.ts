import { describe, expect, it } from 'vitest';
import { ffv1SliceCount, nativeThreadCount } from '../../src/server/native-threads.js';

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

describe('ffv1SliceCount', () => {
  it.each([
    [2, 4],
    [3, 16],
    [8, 16],
  ])('uses a valid FFV1 slice grid for %i threads (%i)', (threads, expected) => {
    expect(ffv1SliceCount(threads)).toBe(expected);
  });
});
