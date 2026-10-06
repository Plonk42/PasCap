import { describe, expect, it } from 'vitest';
import { settingPresentation } from '../../src/web/setting-scope.js';

describe('setting scope wording', () => {
  it.each(['Exposure', 'Layer opacity', 'Speed'])('explains both animated states consistently for %s', (label) => {
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

  it.each(['Clip', 'Layer'] as const)('names the editable static %s base', (baseLabel) => {
    expect(
      settingPresentation({ keyed: false, active: false, baseAvailable: true, baseLabel, label: 'Opacity', frame: 0 }),
    ).toEqual({
      scope: `${baseLabel} base`,
      hint: `Editing the static ${baseLabel.toLowerCase()} base. This setting has no keyframes on the layer.`,
    });
  });

  it('explains how to edit an empty layer without inventing a clip base', () => {
    expect(
      settingPresentation({
        keyed: false,
        active: false,
        baseAvailable: false,
        baseLabel: 'Clip',
        label: 'Speed',
        frame: 0,
      }),
    ).toEqual({
      scope: 'No clip selected',
      hint: 'Select a clip to edit its static base, or click the Speed diamond to animate this setting on the layer.',
    });
  });
});
