import { describe, expect, it } from 'vitest';
import { settingPresentation } from '../../src/web/setting-scope.js';

describe('setting scope wording', () => {
  it.each(['Exposure', 'Opacity', 'Speed'])('explains both animated states consistently for %s', (label) => {
    const context = { keyed: true, baseAvailable: true, baseLabel: 'Clip' as const, label, frame: 30 };
    expect(settingPresentation({ ...context, active: true })).toEqual({
      scope: 'Keyframe at playhead',
      hint: `Editable keyframe at timeline frame 30. Edits change only ${label} at this shared layer point.`,
    });
    expect(settingPresentation({ ...context, active: false })).toEqual({
      scope: 'Animated · add a keyframe to edit',
      hint: `Read-only animated value at timeline frame 30. Click the ${label} diamond to add a keyframe here, then edit the value.`,
    });
  });

  it.each(['Exposure', 'Opacity', 'Speed'])('labels unkeyed %s as Not animated without static-base jargon', (label) => {
    expect(
      settingPresentation({ keyed: false, active: false, baseAvailable: true, baseLabel: 'Clip', label, frame: 0 }),
    ).toEqual({
      scope: 'Not animated',
      hint: `Editing ${label}. Add keyframes to animate this setting on the row.`,
    });
  });

  it.each(['Exposure', 'Speed'])('explains %s on an empty layer without inventing a static layer base', (label) => {
    expect(
      settingPresentation({
        keyed: false,
        active: false,
        baseAvailable: false,
        baseLabel: 'Clip',
        label,
        frame: 0,
      }),
    ).toEqual({
      scope: 'No clip selected',
      hint: `Select a clip to edit ${label}, or click the ${label} diamond to animate this setting on the row.`,
    });
  });
  it('keeps unkeyed Opacity available on an empty row', () => {
    expect(
      settingPresentation({
        keyed: false,
        active: false,
        baseAvailable: true,
        baseLabel: 'Layer',
        label: 'Opacity',
        frame: 0,
      }),
    ).toEqual({
      scope: 'Not animated',
      hint: 'Editing Opacity. Add keyframes to animate this setting on the row.',
    });
  });
});
