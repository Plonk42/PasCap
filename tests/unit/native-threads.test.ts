import { describe, expect, it } from 'vitest';
import { ffv1SliceArguments, nativeThreadCount } from '../../src/server/native-threads.js';

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

describe('ffv1SliceArguments', () => {
  it.each([
    [2, []],
    [3, ['-slices', '16']],
    [8, ['-slices', '16']],
  ])('chooses FFV1 slicing for %i threads', (threads, expected) => {
    expect(ffv1SliceArguments(threads)).toEqual(expected);
  });
});
