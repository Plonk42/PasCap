import { describe, expect, it, vi } from 'vitest';
import { validateNumberDraft } from '../../src/web/NumberField.js';

describe('numeric draft validation', () => {
  it.each(['', ' ', '\t\n'])('does not coerce empty input %j to zero', (draft) => {
    expect(validateNumberDraft(draft)).toEqual({ valid: false, error: 'Enter a number; this field cannot be empty.' });
  });

  it.each(['NaN', 'Infinity', '-Infinity', '1e309', '-1e309', '12frames', '-', '.', '1e', '--1', '1,5'])(
    'rejects nonfinite or incomplete input %j',
    (draft) => {
      expect(validateNumberDraft(draft)).toEqual({ valid: false, error: 'Enter a finite number (for example, 1.5).' });
    },
  );

  it.each(['0x10', '0b10', '0o10'])('rejects nondecimal coercion %j', (draft) => {
    expect(validateNumberDraft(draft)).toEqual({ valid: false, error: 'Use a decimal number (for example, 1.5).' });
  });

  it.each([
    ['0', 0],
    [' 12 ', 12],
    ['-6', -6],
    ['+1.5', 1.5],
    ['.25', 0.25],
    ['-.5', -0.5],
    ['1.', 1],
    ['2e-1', 0.2],
    ['1E2', 100],
  ] as const)('accepts a complete decimal %j without rounding', (draft, value) => {
    expect(validateNumberDraft(draft)).toEqual({ valid: true, value });
  });

  it('validates inclusive minimum and maximum without clamping', () => {
    const constraints = Object.freeze({ min: 0.1, max: 8 });
    expect(validateNumberDraft('0.1', constraints)).toEqual({ valid: true, value: 0.1 });
    expect(validateNumberDraft('8', constraints)).toEqual({ valid: true, value: 8 });
    expect(validateNumberDraft('0', constraints)).toEqual({ valid: false, error: 'Enter 0.1 or greater.' });
    expect(validateNumberDraft('8.01', constraints)).toEqual({ valid: false, error: 'Enter 8 or less.' });
    expect(validateNumberDraft('0.137', constraints)).toEqual({ valid: true, value: 0.137 });
  });

  it('keeps zero and negative values valid when the control allows them', () => {
    expect(validateNumberDraft('0', { min: 0, max: 1 })).toEqual({ valid: true, value: 0 });
    expect(validateNumberDraft('-60', { min: -60, max: 12 })).toEqual({ valid: true, value: -60 });
    expect(validateNumberDraft('-60.5', { min: -60, max: 12 })).toEqual({
      valid: false,
      error: 'Enter -60 or greater.',
    });
  });

  it.each(['1.5', '-0.5', '1e-1'])('requires whole frames for %j, never rounding', (draft) => {
    expect(validateNumberDraft(draft, { integer: true })).toEqual({
      valid: false,
      error: 'Enter a whole number (no decimals).',
    });
  });

  it('accepts whole-number notation and the exact frame ceiling', () => {
    const frames = { integer: true, min: 0, max: 2_147_483_647 };
    expect(validateNumberDraft('30.0', frames)).toEqual({ valid: true, value: 30 });
    expect(validateNumberDraft('3e1', frames)).toEqual({ valid: true, value: 30 });
    expect(validateNumberDraft('2147483647', frames)).toEqual({ valid: true, value: 2_147_483_647 });
    expect(validateNumberDraft('2147483648', frames)).toEqual({ valid: false, error: 'Enter 2147483647 or less.' });
    expect(validateNumberDraft('9007199254740992', { integer: true })).toEqual({
      valid: false,
      error: 'Enter a whole number within the safe integer range.',
    });
  });

  it('supports one-sided and changing bounds', () => {
    expect(validateNumberDraft('25', { integer: true, min: 26 })).toEqual({
      valid: false,
      error: 'Enter 26 or greater.',
    });
    expect(validateNumberDraft('25', { integer: true, min: 24 })).toEqual({ valid: true, value: 25 });
    expect(validateNumberDraft('25', { max: 24 })).toEqual({ valid: false, error: 'Enter 24 or less.' });
  });

  it('runs contextual validation only after basic validation succeeds', () => {
    const validate = vi.fn((value: number) =>
      value === 30 ? 'Frame 30 already has a key. Choose a different frame.' : null,
    );
    const constraints = { integer: true, min: 0, max: 120, validate };
    expect(validateNumberDraft('', constraints).valid).toBe(false);
    expect(validateNumberDraft('NaN', constraints).valid).toBe(false);
    expect(validateNumberDraft('1.5', constraints).valid).toBe(false);
    expect(validateNumberDraft('121', constraints).valid).toBe(false);
    expect(validate).not.toHaveBeenCalled();
    expect(validateNumberDraft('30', constraints)).toEqual({
      valid: false,
      error: 'Frame 30 already has a key. Choose a different frame.',
    });
    expect(validateNumberDraft('31', constraints)).toEqual({ valid: true, value: 31 });
    expect(validate.mock.calls).toEqual([[30], [31]]);
  });
});
