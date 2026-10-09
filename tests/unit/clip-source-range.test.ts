import { describe, expect, it, vi } from 'vitest';
import { applyCommand } from '../../src/shared/commands.js';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import { createClip, createProject, projectSchema } from '../../src/shared/model.js';
import { NEUTRAL_SPATIAL_POSE } from '../../src/shared/spatial.js';
import { calculateLayout } from '../../src/shared/timeline.js';
import { formatTimecode } from '../../src/shared/timing.js';
import { validateFrameDraft } from '../../src/web/FrameField.js';
import { clipSourceBoundary, planClipSourceRange } from '../../src/web/clip-source-range.js';

const MAX_FRAME = 2_147_483_647;
const FORMAT_ERROR = 'Use HH:MM:SS:FF (30 fps NDF), or a whole source frame.';

function rangeProject(ripple = true) {
  const project = createProject('source-range', 'Source range');
  project.layers[0]!.ripple = ripple;
  project.clips = [
    { ...createClip('first', 'recording', 100, 300), start: 20 },
    { ...createClip('second', 'recording', 0, 100), start: ripple ? 220 : 260 },
    { ...createClip('third', 'recording', 0, 100), start: ripple ? 320 : 400 },
  ];
  project.layers[0]!.transitions = [
    { leftId: 'first', rightId: 'second', type: 'cut', duration: 0 },
    { leftId: 'second', rightId: 'third', type: 'cut', duration: 0 },
  ];
  return projectSchema.parse(project);
}

describe('source frame drafts', () => {
  it.each([
    ['00:00:00:00', 0],
    ['00:00:00:29', 29],
    ['00:00:01:00', 30],
    ['00:00:59:29', 1_799],
    ['00:01:00:00', 1_800],
    ['00:59:59:29', 107_999],
    ['01:00:00:00', 108_000],
    [' 1:00:00:01 ', 108_001],
    ['999:59:59:29', 107_999_999],
    ['1000:00:00:00', 108_000_000],
    ['19884:06:28:07', MAX_FRAME],
  ] as const)('parses %j as exact nominal 30 fps NDF frame %i', (draft, value) => {
    expect(validateFrameDraft(draft, { min: 0, max: MAX_FRAME })).toEqual({ valid: true, value });
    expect(formatTimecode(value)).toBe(draft.trim().replace(/^1:/, '01:'));
  });

  it('accepts the original exclusive OUT, not just its last included image', () => {
    expect(validateFrameDraft('00:00:20:00', { min: 151, max: 600 })).toEqual({ valid: true, value: 600 });
    expect(validateFrameDraft('600', { min: 151, max: 600 })).toEqual({ valid: true, value: 600 });
    expect(validateFrameDraft('00:00:20:01', { min: 151, max: 600 })).toEqual({
      valid: false,
      error: 'Enter 600 or less.',
    });
  });

  it.each([
    ['0', 0],
    [' +30 ', 30],
    ['30.0', 30],
    ['30.', 30],
    ['3e1', 30],
    ['300E-1', 30],
    ['.3e2', 30],
    ['2147483647', MAX_FRAME],
    ['2.147483647e9', MAX_FRAME],
  ] as const)('accepts whole-valued decimal/scientific notation %j', (draft, value) => {
    expect(validateFrameDraft(draft, { min: 0, max: MAX_FRAME, integer: false })).toEqual({ valid: true, value });
  });

  it.each(['', ' ', '\t\n'])('rejects empty draft %j without coercion', (draft) => {
    expect(validateFrameDraft(draft, { min: 0, max: 600 })).toEqual({
      valid: false,
      error: 'Enter a number; this field cannot be empty.',
    });
  });

  it.each(['1.5', '.5', '1e-1', '30.0001'])('rejects fractional frames %j without rounding', (draft) => {
    expect(validateFrameDraft(draft, { integer: false, min: 0, max: 600 })).toEqual({
      valid: false,
      error: 'Enter a whole number (no decimals).',
    });
  });

  it.each([
    '00:00:00:30',
    '00:00:60:00',
    '00:60:00:00',
    '00:00:00',
    '00:00:00:0',
    '00:0:00:00',
    '00:00:00;01',
    '-01:00:00:00',
    '00:00:00:01.5',
  ])('rejects malformed/unsupported timecode %j', (draft) => {
    expect(validateFrameDraft(draft, { min: 0, max: MAX_FRAME })).toEqual({ valid: false, error: FORMAT_ERROR });
  });

  it.each(['NaN', 'Infinity', '1e309', '12frames', '0x10', '1,000'])('rejects invalid numeric format %j', (draft) => {
    expect(validateFrameDraft(draft, { min: 0, max: MAX_FRAME }).valid).toBe(false);
  });

  it('enforces inclusive source bounds and the maximum stored integer frame', () => {
    expect(validateFrameDraft('00:00:00:09', { min: 10, max: 600 })).toEqual({
      valid: false,
      error: 'Enter 10 or greater.',
    });
    expect(validateFrameDraft('00:00:00:10', { min: 10, max: 600 })).toEqual({ valid: true, value: 10 });
    expect(validateFrameDraft('-1', { min: 0, max: MAX_FRAME })).toEqual({
      valid: false,
      error: 'Enter 0 or greater.',
    });
    expect(validateFrameDraft('2147483648', { min: 0, max: MAX_FRAME })).toEqual({
      valid: false,
      error: 'Enter 2147483647 or less.',
    });
    expect(validateFrameDraft('9007199254740992', {})).toEqual({
      valid: false,
      error: 'Enter a whole number within the safe integer range.',
    });
  });

  it('passes exact parsed frames to contextual validation only after syntax and bounds succeed', () => {
    const validate = vi.fn((value: number) => (value === 30 ? 'This range conflicts with a fade.' : null));
    const constraints = Object.freeze({ min: 0, max: 600, validate });
    for (const draft of ['', '1.5', '00:00:00:30', '-1', '601']) {
      expect(validateFrameDraft(draft, constraints).valid).toBe(false);
    }
    expect(validate).not.toHaveBeenCalled();
    for (const draft of ['00:00:01:00', '3e1']) {
      expect(validateFrameDraft(draft, constraints)).toEqual({
        valid: false,
        error: 'This range conflicts with a fade.',
      });
    }
    expect(validateFrameDraft('00:00:01:01', constraints)).toEqual({ valid: true, value: 31 });
    expect(validate.mock.calls).toEqual([[30], [30], [31]]);
  });
});

describe('captured source-bar pointer geometry', () => {
  it.each([
    ['in', 0.24, 150],
    ['in', 0.25, 151],
    ['in', -0.25, 150],
    ['in', -0.26, 149],
    ['out', 0.25, 511],
    ['out', -0.26, 509],
  ] as const)('rounds %s travel %f once against the full original', (edge, delta, boundary) => {
    const clip = createClip('excerpt', 'recording', 150, 510);
    expect(clipSourceBoundary(clip, edge, 600, delta, 300)).toBe(boundary);
  });

  it('uses captured geometry rather than accumulating rounded moves or using trimmed duration', () => {
    const clip = createClip('excerpt', 'recording', 150, 510);
    const before = structuredClone(clip);
    const boundaries = [0.2, 0.4, 0.6, 0].map((delta) => clipSourceBoundary(clip, 'in', 600, delta, 300));
    expect(boundaries).toEqual([150, 151, 151, 150]);
    expect(clipSourceBoundary(clip, 'in', 600, 30, 300)).toBe(210);
    expect(clipSourceBoundary(clip, 'in', 600, 60, 600)).toBe(210);
    expect(clip).toEqual(before);
  });

  it.each([
    ['in', -10_000, 0],
    ['in', 10_000, 509],
    ['out', -10_000, 151],
    ['out', 10_000, 600],
  ] as const)('stops %s at source limits with one retained frame', (edge, delta, boundary) => {
    expect(clipSourceBoundary(createClip('excerpt', 'recording', 150, 510), edge, 600, delta, 300)).toBe(boundary);
  });

  it('keeps a one-frame selection within the full original boundaries', () => {
    const clip = createClip('excerpt', 'recording', 599, 600);
    expect(clipSourceBoundary(clip, 'in', 600, 1_000, 300)).toBe(599);
    expect(clipSourceBoundary(clip, 'out', 600, -1_000, 300)).toBe(600);
    expect(clipSourceBoundary(clip, 'in', 600, -1_000, 300)).toBe(0);
  });
});

describe('atomic clip source-range plans', () => {
  it.each([
    ['in', 150, 150, 300, 20, [20, 170, 270]],
    ['out', 250, 100, 250, 169, [20, 170, 270]],
    ['in', 0, 0, 300, 20, [20, 320, 420]],
    ['out', 600, 100, 600, 519, [20, 520, 620]],
  ] as const)(
    'plans %s=%i as an ordinary trim and re-sequences the Ripple suffix',
    (edge, boundary, sourceIn, sourceOut, frame, starts) => {
      const project = rangeProject();
      const before = structuredClone(project);
      const plan = planClipSourceRange(project, project.clips[0]!, edge, boundary, 600, 75);
      expect(plan.error).toBe('');
      expect(plan.command).toEqual({ type: 'trim', clipId: 'first', sourceIn, sourceOut });
      expect(plan.document).toEqual(applyCommand(project, plan.command));
      expect(plan.document.clips.map((clip) => clip.start)).toEqual(starts);
      expect(calculateLayout(plan.document).clips.map((clip) => clip.start)).toEqual(starts);
      expect(plan.frame).toBe(frame);
      expect(plan.document.clips.slice(1).map((clip) => [clip.sourceIn, clip.sourceOut])).toEqual([
        [0, 100],
        [0, 100],
      ]);
      expect(project).toEqual(before);
    },
  );

  it.each(['in', 'out'] as const)(
    'keeps positioned starts fixed for %s instead of retaining the old timeline OUT',
    (edge) => {
      const project = rangeProject(false);
      const plan = planClipSourceRange(project, project.clips[0]!, edge, edge === 'in' ? 150 : 250, 600, 75);
      expect(plan.error).toBe('');
      expect(plan.document.clips.map((clip) => clip.start)).toEqual([20, 260, 400]);
      expect(calculateLayout(plan.document).clips[0]).toMatchObject({ start: 20, end: 170, duration: 150 });
      expect(plan.frame).toBe(edge === 'in' ? 20 : 169);
    },
  );

  it('recompiles the suffix at its new project time using overriding row Speed, not raw source length or clip rate', () => {
    const project = rangeProject();
    project.clips[0]!.speed = { mode: 'constant', rate: 4 };
    project.layers[0]!.keyframes = [
      { frame: 0, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, speed: 1 } },
      { frame: 150, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, speed: 2 } },
    ];
    const before = structuredClone(project);
    expect(calculateLayout(project).clips.map(({ start, duration }) => [start, duration])).toEqual([
      [20, 165],
      [185, 50],
      [235, 50],
    ]);
    const plan = planClipSourceRange(project, project.clips[0]!, 'out', 200, 600, 75);
    expect(plan.error).toBe('');
    const layout = calculateLayout(plan.document);
    expect(layout.clips.map(({ start, duration }) => [start, duration])).toEqual([
      [20, 100],
      [120, 65],
      [185, 50],
    ]);
    expect(plan.document.clips.map((clip) => clip.start)).toEqual([20, 120, 185]);
    expect(plan.frame).toBe(119);
    expect(layout.clips[0]!.retiming.sourceAt(99)).toBe(199);
    expect(layout.clips[1]!.retiming.sourceAt(30)).toBe(30);
    expect(layout.clips[1]!.retiming.sourceAt(31)).toBe(32);
    expect(plan.document.layers[0]!.keyframes).toEqual(before.layers[0]!.keyframes);
    expect(plan.document.clips[0]!.speed).toEqual(before.clips[0]!.speed);
    expect(project).toEqual(before);
  });

  it('preserves row points, appearance, original speed/spatial anchors and independent nested data', () => {
    const project = rangeProject();
    const clip = project.clips[0]!;
    clip.speed = { mode: 'ramp', startRate: 1, endRate: 2, anchorIn: 0, anchorOut: 600, curve: 'linear' };
    clip.spatial.base.translateX = 0.25;
    clip.spatial.keyframes = [
      { frame: 0, interpolation: 'linear', values: { ...NEUTRAL_SPATIAL_POSE, scale: 2 } },
      { frame: 600, interpolation: 'smooth', values: { ...NEUTRAL_SPATIAL_POSE, rotation: 90 } },
    ];
    project.layers[0]!.colour.temperature = 0.25;
    project.layers[0]!.opacity = 0.7;
    project.layers[0]!.keyframes = [
      { frame: 10, interpolation: 'smooth', values: { ...EMPTY_KEY_VALUES, exposure: 0.5 } },
      { frame: 1_000, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, opacity: 0.4 } },
    ];
    const before = structuredClone(project);
    const plan = planClipSourceRange(project, clip, 'in', 200, 600, 75);
    expect(plan.error).toBe('');
    expect(plan.document.layers).toEqual(before.layers);
    expect(plan.document.clips[0]!.speed).toEqual(before.clips[0]!.speed);
    expect(plan.document.clips[0]!.spatial).toEqual(before.clips[0]!.spatial);
    expect(plan.document.clips[0]!.spatial).not.toBe(clip.spatial);
    expect(plan.document.clips[0]!.spatial.keyframes[0]!.values).not.toBe(clip.spatial.keyframes[0]!.values);
    expect(plan.document.layers[0]!.keyframes[0]!.values).not.toBe(project.layers[0]!.keyframes[0]!.values);
    expect(project).toEqual(before);
  });

  it.each([
    ['in', -1],
    ['in', 300],
    ['in', 301],
    ['in', 100.5],
    ['out', 100],
    ['out', 99],
    ['out', 601],
    ['out', 250.5],
    ['out', Number.NaN],
    ['out', Number.POSITIVE_INFINITY],
    ['out', MAX_FRAME + 1],
  ] as const)('returns the exact base document and playhead on invalid %s=%s', (edge, boundary) => {
    const project = rangeProject();
    const before = structuredClone(project);
    const plan = planClipSourceRange(project, project.clips[0]!, edge, boundary, 600, 75);
    expect(plan.document).toBe(project);
    expect(plan.frame).toBe(75);
    expect(plan.error).toContain('Adjust this range or the conflicting fades and clips.');
    expect(plan.command.type).toBe('trim');
    expect(plan.command[edge === 'in' ? 'sourceIn' : 'sourceOut']).toBe(boundary);
    expect(project).toEqual(before);
  });

  it('allows the maximum stored source OUT without requesting an image at that exclusive boundary', () => {
    const project = createProject('maximum', 'Maximum boundary');
    project.clips = [createClip('excerpt', 'recording', MAX_FRAME - 10, MAX_FRAME - 1)];
    const plan = planClipSourceRange(project, project.clips[0]!, 'out', MAX_FRAME, MAX_FRAME, 3);
    expect(plan.error).toBe('');
    expect(plan.command.sourceOut).toBe(MAX_FRAME);
    expect(plan.frame).toBe(9);
    expect(calculateLayout(plan.document).clips[0]!.retiming.sourceAt(plan.frame)).toBe(MAX_FRAME - 1);
  });

  it.each([
    ['dissolve exceeds retained duration', 'cross-dissolve', true, 'out', 120, 100],
    ['positioned dissolve loses exact overlap', 'cross-dissolve', false, 'out', 250, 300],
    ['positioned black fade gains a gap', 'fade-through-black', false, 'out', 250, 220],
    ['positioned cut would overlap its neighbour', 'cut', false, 'out', 400, 300],
  ] as const)('rejects %s atomically', (_name, type, ripple, edge, boundary, secondStart) => {
    const project = rangeProject(ripple);
    project.clips[1]!.start = secondStart;
    project.clips[2]!.start = ripple ? secondStart + 100 : 500;
    project.layers[0]!.transitions[0] =
      type === 'cut'
        ? { leftId: 'first', rightId: 'second', type, duration: 0 }
        : { leftId: 'first', rightId: 'second', type, duration: 30 };
    // Positioned dissolve starts exactly 30 frames before the original OUT.
    if (type === 'cross-dissolve' && !ripple) project.clips[1]!.start = 190;
    const base = projectSchema.parse(project);
    const before = structuredClone(base);
    const plan = planClipSourceRange(base, base.clips[0]!, edge, boundary, 600, 75);
    expect(plan.document).toBe(base);
    expect(plan.frame).toBe(75);
    expect(plan.error).not.toBe('');
    expect(base).toEqual(before);
  });

  it('retains a valid Ripple dissolve and its exact duration while re-sequencing', () => {
    const project = rangeProject();
    project.layers[0]!.transitions[0] = {
      leftId: 'first',
      rightId: 'second',
      type: 'cross-dissolve',
      duration: 30,
    };
    const plan = planClipSourceRange(project, project.clips[0]!, 'out', 250, 600, 75);
    expect(plan.error).toBe('');
    expect(plan.document.clips.map((clip) => clip.start)).toEqual([20, 140, 240]);
    expect(plan.document.layers[0]!.transitions).toEqual(project.layers[0]!.transitions);
    expect(plan.frame).toBe(169);
  });

  it('uses static clip retiming for the selected OUT preview when no row Speed participates', () => {
    const project = rangeProject();
    project.clips[0]!.speed = { mode: 'constant', rate: 2 };
    const plan = planClipSourceRange(project, project.clips[0]!, 'out', 250, 600, 75);
    expect(plan.error).toBe('');
    const placed = calculateLayout(plan.document).clips[0]!;
    expect(placed).toMatchObject({ start: 20, duration: 75, end: 95 });
    expect(plan.frame).toBe(94);
    expect(placed.retiming.sourceAt(plan.frame - placed.start)).toBe(248);
    expect(plan.document.clips.map((clip) => clip.start)).toEqual([20, 95, 195]);
  });

  it('does not reuse an earlier valid draft when the final requested range conflicts with fades', () => {
    const project = rangeProject();
    project.layers[0]!.openingFade = 40;
    const before = structuredClone(project);
    const valid = planClipSourceRange(project, project.clips[0]!, 'out', 200, 600, 75);
    expect(valid.error).toBe('');
    const invalid = planClipSourceRange(project, project.clips[0]!, 'out', 120, 600, 75);
    expect(invalid.document).toBe(project);
    expect(invalid.frame).toBe(75);
    expect(invalid.error).toContain('Fade/transition regions overlap or exceed clip first.');
    expect(project).toEqual(before);
  });
});
