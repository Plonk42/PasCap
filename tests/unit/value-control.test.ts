import { describe, expect, it, vi } from 'vitest';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { COLOUR_CONTROLS } from '../../src/shared/colour.js';
import { EMPTY_KEY_VALUES, KEYFRAME_SETTINGS } from '../../src/shared/keyframes.js';
import { createClip, createProject } from '../../src/shared/model.js';
import { validateNumberDraft } from '../../src/web/NumberField.js';
import {
  createValueControlState,
  syncValueControlState,
  transitionValueControl,
  validateValueControlValue,
  type ValueControlContext,
  type ValueControlState,
} from '../../src/web/ValueControl.js';

const context = (changes: Partial<ValueControlContext> = {}): Readonly<ValueControlContext> =>
  Object.freeze({
    value: 1,
    min: 0.1,
    max: 8,
    step: 0.05,
    disabled: false,
    integer: false,
    resetKey: 'clip-a',
    ...changes,
  });
const begin = (state = createValueControlState(context())) =>
  transitionValueControl(state, { type: 'begin', pointerId: 7 });
const change = (state: ValueControlState, value: number, validate?: (value: number) => string | null) =>
  transitionValueControl(state, { type: 'change', value }, validate);
const finish = (state: ValueControlState, validate?: (value: number) => string | null) =>
  transitionValueControl(state, { type: 'finish', pointerId: 7 }, validate);

describe('locally drafted native value controls', () => {
  it('keeps every pointer movement local and publishes only the final value once', () => {
    const initial = createValueControlState(context());
    const captured = begin(initial);
    expect(captured.commit).toBeNull();
    let state = captured.state;
    for (const value of [1.5, 2, 0.25, 1.75]) {
      const result = change(state, value);
      expect(result.commit).toBeNull();
      expect(result.state.draft).toBe(value);
      state = result.state;
    }
    const released = finish(state);
    expect(released.commit).toBe(1.75);
    expect(released.state.pointer).toBeNull();
    expect(finish(released.state).commit).toBeNull();
    expect(change(released.state, 1.75).commit).toBeNull();
    expect(initial).toEqual(createValueControlState(context()));
  });

  it('does not round an off-step exact value on a click/release with no input', () => {
    const initial = createValueControlState(context({ value: 0.137123456789 }));
    const released = finish(begin(initial).state);
    expect(released.commit).toBeNull();
    expect(released.state.draft).toBe(0.137123456789);
  });

  it('does not publish an unchanged gesture or a wrong pointer release', () => {
    const state = change(begin().state, 1).state;
    expect(transitionValueControl(state, { type: 'finish', pointerId: 8 }).state).toBe(state);
    expect(finish(state).commit).toBeNull();
  });

  it('creates no edit when pointer movement returns to the captured original value', () => {
    const moved = change(begin().state, 4);
    const returned = change(moved.state, 1);
    expect(returned.commit).toBeNull();
    expect(finish(returned.state).commit).toBeNull();
  });

  it.each(['Escape', 'pointercancel', 'lostpointercapture', 'window blur'])('%s restores without an edit', () => {
    const moved = change(begin().state, 4).state;
    const cancelled = transitionValueControl(moved, { type: 'cancel' });
    expect(cancelled.commit).toBeNull();
    expect(cancelled.state.draft).toBe(1);
    expect(cancelled.state.error).toBeNull();
    expect(change(cancelled.state, 5).state).toBe(cancelled.state);
    const released = finish(cancelled.state);
    expect(released.commit).toBeNull();
    expect(released.state).toEqual(createValueControlState(context()));
    expect(change(released.state, 2).commit).toBe(2);
  });

  it('permits a fresh gesture after a cancelled pointer never delivers its release', () => {
    const cancelled = transitionValueControl(change(begin().state, 4).state, { type: 'cancel' }).state;
    const captured = transitionValueControl(cancelled, { type: 'begin', pointerId: 9 });
    const moved = change(captured.state, 2);
    expect(moved.commit).toBeNull();
    expect(transitionValueControl(moved.state, { type: 'finish', pointerId: 9 }).commit).toBe(2);
  });

  it('permits precise entry after cancellation while suppressing the obsolete native gesture', () => {
    const cancelled = transitionValueControl(change(begin().state, 4).state, { type: 'cancel' }).state;
    const exact = transitionValueControl(cancelled, { type: 'exact', value: 1.23456789 });
    expect(exact.commit).toBe(1.23456789);
    expect(exact.state.pointer).toEqual({ id: 7, cancelled: true });
    const synced = syncValueControlState(exact.state, context({ value: 1.23456789 }));
    expect(change(synced, 5).state).toBe(synced);
    expect(finish(synced).commit).toBeNull();
    expect(finish(synced).state.draft).toBe(1.23456789);
    expect(transitionValueControl(begin().state, { type: 'exact', value: 2 }).commit).toBeNull();
    expect(
      transitionValueControl(createValueControlState(context({ disabled: true })), { type: 'exact', value: 2 }).commit,
    ).toBeNull();
  });

  it('allows one validated edit for each native keyboard/fill change without a pointer', () => {
    let state = createValueControlState(context());
    for (const value of [1.05, 1.1, 1.15]) {
      const result = change(state, value);
      expect(result.commit).toBe(value);
      expect(change(result.state, value).commit).toBeNull();
      state = syncValueControlState(result.state, context({ value }));
    }
  });

  it('retains an invalid final value instead of committing the earlier valid movement', () => {
    const validate = (value: number) => (value > 2 ? 'This speed overlaps the next clip.' : null);
    const valid = change(begin().state, 1.5, validate);
    const invalid = change(valid.state, 3, validate);
    expect(invalid.commit).toBeNull();
    expect(invalid.state.error).toBe('This speed overlaps the next clip.');
    const released = finish(invalid.state, validate);
    expect(released.commit).toBeNull();
    expect(released.state.draft).toBe(3);
    expect(released.state.error).toBe('This speed overlaps the next clip.');
    expect(released.state.pointer).toBeNull();
    expect(change(released.state, 1.75, validate).commit).toBe(1.75);
  });

  it('commits a corrected final pointer position and clears its previous error', () => {
    const validate = (value: number) => (value > 2 ? 'Conflict' : null);
    const invalid = change(begin().state, 3, validate);
    const corrected = change(invalid.state, 1.5, validate);
    expect(corrected.state.error).toBeNull();
    expect(corrected.commit).toBeNull();
    expect(finish(corrected.state, validate).commit).toBe(1.5);
  });

  it('revalidates the final value using the latest contextual constraint', () => {
    const moved = change(begin().state, 2, () => null);
    const released = finish(moved.state, () => 'The transition no longer fits.');
    expect(released.commit).toBeNull();
    expect(released.state.draft).toBe(2);
    expect(released.state.error).toBe('The transition no longer fits.');
  });

  it('keeps an invalid non-pointer change editable until correction or Escape', () => {
    const invalid = change(createValueControlState(context()), 9);
    expect(invalid.commit).toBeNull();
    expect(invalid.state.draft).toBe(9);
    expect(invalid.state.error).toBe('Enter 8 or less.');
    const restored = transitionValueControl(invalid.state, { type: 'restore' });
    expect(restored.commit).toBeNull();
    expect(restored.state).toEqual(createValueControlState(context()));
  });

  it.each([
    { value: 2 },
    { resetKey: 'clip-b' },
    { disabled: true },
    { min: 0.25 },
    { max: 4 },
    { step: 0.1 },
    { integer: true },
  ])('cancels a captured edit when its context changes: %j', (changes) => {
    const moved = change(begin().state, 3).state;
    const nextContext = context(changes);
    const synced = syncValueControlState(moved, nextContext);
    expect(synced.draft).toBe(nextContext.value);
    expect(synced.error).toBeNull();
    expect(synced.pointer).toEqual({ id: 7, cancelled: true });
    expect(change(synced, 4).commit).toBeNull();
    expect(finish(synced).commit).toBeNull();
    expect(finish(synced).state).toEqual(createValueControlState(nextContext));
  });

  it('resets invalid drafts for an identical-valued selection and keeps unchanged contexts stable', () => {
    const invalid = change(createValueControlState(context()), 9).state;
    expect(syncValueControlState(invalid, context())).toBe(invalid);
    const nextContext = context({ resetKey: 'clip-b' });
    expect(syncValueControlState(invalid, nextContext)).toEqual(createValueControlState(nextContext));
  });

  it('never accepts a value while disabled', () => {
    const state = createValueControlState(context({ disabled: true }));
    expect(begin(state).state).toBe(state);
    expect(change(state, 2).state).toBe(state);
  });
});

describe('shared exact values and contextual validation', () => {
  it.each(KEYFRAME_SETTINGS)(
    'preserves $label bounds and exact decimal precision without step quantisation',
    (setting) => {
      const constraints = { min: setting.min, max: setting.max };
      for (const value of [setting.min, setting.max])
        expect(validateValueControlValue(value, constraints)).toEqual({ valid: true, value });
      const precise = setting.min + (setting.max - setting.min) * 0.137123456789;
      expect(validateValueControlValue(precise, constraints)).toEqual({ valid: true, value: precise });
      expect(validateValueControlValue(setting.min - 1, constraints).valid).toBe(false);
      expect(validateValueControlValue(setting.max + 1, constraints).valid).toBe(false);
    },
  );

  it('uses stored 0–1 Opacity, not a percentage-valued edit', () => {
    const initial = createValueControlState(context({ value: 1, min: 0, max: 1, step: 0.01 }));
    expect(change(initial, 0).commit).toBe(0);
    expect(change(initial, 0.137123456789).commit).toBe(0.137123456789);
    expect(change(initial, 50).commit).toBeNull();
  });

  it('uses the unchanged seven colour bounds and gains from −60 to 12 dB', () => {
    for (const setting of COLOUR_CONTROLS)
      expect(KEYFRAME_SETTINGS.find((item) => item.key === setting.key)).toMatchObject({
        min: setting.min,
        max: setting.max,
        step: setting.step,
      });
    const gain = { min: -60, max: 12 };
    for (const value of [-60, -6.123456789, 0, 12])
      expect(validateValueControlValue(value, gain)).toEqual({ valid: true, value });
    expect(validateValueControlValue(-60.01, gain).valid).toBe(false);
    expect(validateValueControlValue(12.01, gain).valid).toBe(false);
  });

  it('retains NumberField validation for empty/nonfinite/invalid precise drafts', () => {
    const validate = vi.fn((value: number) => (value === 2 ? 'The fade does not fit.' : null));
    const constraints = { min: 0.1, max: 8, validate };
    for (const text of ['', ' ', 'NaN', 'Infinity', '0', '8.01'])
      expect(validateNumberDraft(text, constraints).valid).toBe(false);
    expect(validate).not.toHaveBeenCalled();
    expect(validateNumberDraft('2', constraints)).toEqual({ valid: false, error: 'The fade does not fit.' });
    expect(validateNumberDraft('0.137123456789', constraints)).toEqual({ valid: true, value: 0.137123456789 });
  });

  it('turns thrown contextual validation failures into editable inline errors', () => {
    expect(
      validateValueControlValue(2, {
        min: 0.1,
        max: 8,
        validate: () => {
          throw new Error('The closing fade does not fit.');
        },
      }),
    ).toEqual({ valid: false, error: 'The closing fade does not fit.' });
  });

  it('validates actual timing conflicts without editing the document, shortening fades or adding keys', () => {
    const project = createProject('widgets', 'Widgets');
    const clip = createClip('clip', 'source', 0, 120);
    project.clips = [clip];
    project.layers[0]!.closingFade = 60;
    const before = structuredClone(project);
    const history = new EditHistory(project);
    const command = (rate: number) => ({
      type: 'speed' as const,
      clipId: clip.id,
      speed: { mode: 'constant' as const, rate },
    });
    const validate = (rate: number): string | null => {
      try {
        applyCommand(project, command(rate));
        return null;
      } catch (cause) {
        return cause instanceof Error ? cause.message : 'Timing conflict';
      }
    };
    const moved = change(begin().state, 1.5, validate);
    const invalid = change(moved.state, 4, validate);
    const rejected = finish(invalid.state, validate);
    expect(rejected.commit).toBeNull();
    expect(rejected.state.error).toBeTruthy();
    expect(project).toEqual(before);
    expect(history.canUndo).toBe(false);
    expect(project.layers[0]!.keyframes).toEqual([]);
    const valid = change(begin(rejected.state).state, 1.75, validate);
    const accepted = finish(valid.state, validate);
    expect(accepted.commit).toBe(1.75);
    history.commit(command(accepted.commit!));
    expect(history.canUndo).toBe(true);
    history.undo();
    expect(history.current).toEqual(before);
    expect(history.canUndo).toBe(false);
  });

  it('updates only an existing row participant when its slider release emits a command', () => {
    const project = createProject('row', 'Row');
    const layer = project.layers[0]!;
    layer.opacity = 0.75;
    layer.keyframes = [
      { frame: 10, interpolation: 'smooth', values: { ...EMPTY_KEY_VALUES, opacity: 0.25, speed: 1 } },
    ];
    const captured = begin(createValueControlState(context({ value: 0.25, min: 0, max: 1, step: 0.01 })));
    const moved = change(captured.state, 0.137123456789);
    expect(moved.commit).toBeNull();
    const released = finish(moved.state);
    const next = applyCommand(project, {
      type: 'layer-key-value',
      layerId: layer.id,
      frame: 10,
      setting: 'opacity',
      value: released.commit!,
    });
    expect(next.layers[0]!.opacity).toBe(0.75);
    expect(next.layers[0]!.keyframes).toEqual([
      { ...layer.keyframes[0], values: { ...layer.keyframes[0]!.values, opacity: 0.137123456789 } },
    ]);
    expect(project.layers[0]!.keyframes[0]!.values.opacity).toBe(0.25);
  });
});
