import { describe, expect, it } from 'vitest';
import { settingPresentation } from '../../src/web/setting-scope.js';

describe('setting scope wording', () => {
  it.each(['Exposure', 'Tint'])('explains both animated states of a clip grade %s in source frames', (label) => {
    const context = { keyed: true, owner: 'clip' as const, label, frame: 30 };
    expect(settingPresentation({ ...context, active: true })).toEqual({
      scope: 'Keyframe at playhead',
      hint: `Editable keyframe at source frame 30. Edits change only ${label} at this clip keyframe.`,
    });
    expect(settingPresentation({ ...context, active: false })).toEqual({
      scope: 'Animated · add a keyframe to edit',
      hint: `Read-only animated value at source frame 30. Click the ${label} diamond to add a keyframe here, then edit the value.`,
    });
  });

  it.each(['Exposure', 'Tint'])('explains both animated states of an adjustment %s in its own frames', (label) => {
    const context = { keyed: true, owner: 'adjustment' as const, label, frame: 12 };
    expect(settingPresentation({ ...context, active: true })).toEqual({
      scope: 'Keyframe at playhead',
      hint: `Editable keyframe at frame 12 of the adjustment. Edits change only ${label} at this adjustment keyframe.`,
    });
    expect(settingPresentation({ ...context, active: false })).toEqual({
      scope: 'Animated · add a keyframe to edit',
      hint: `Read-only animated value at frame 12 of the adjustment. Click the ${label} diamond to add a keyframe here, then edit the value.`,
    });
  });

  it.each(['clip', 'adjustment'] as const)(
    'labels an unkeyed %s setting as Not animated, naming its owner',
    (owner) => {
      expect(settingPresentation({ keyed: false, active: false, owner, label: 'Exposure', frame: 0 })).toEqual({
        scope: 'Not animated',
        hint: `Editing Exposure. Add keyframes to animate this setting on the ${owner}.`,
      });
    },
  );
});
