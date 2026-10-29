interface SettingContext {
  keyed: boolean;
  active: boolean;
  /** What the setting grades: a clip's own grade (source frames) or an adjustment (frames from its start). */
  owner: 'clip' | 'adjustment';
  label: string;
  frame: number;
}

/** One vocabulary for the visible tooltip and screen-reader setting context. */
export function settingPresentation({ keyed, active, owner, label, frame }: SettingContext) {
  const at = owner === 'clip' ? `source frame ${frame}` : `frame ${frame} of the adjustment`;
  if (keyed && active)
    return {
      scope: 'Keyframe at playhead',
      hint: `Editable keyframe at ${at}. Edits change only ${label} at this ${owner} keyframe.`,
    };
  if (keyed)
    return {
      scope: 'Animated · add a keyframe to edit',
      hint: `Read-only animated value at ${at}. Click the ${label} diamond to add a keyframe here, then edit the value.`,
    };
  return {
    scope: 'Not animated',
    hint: `Editing ${label}. Add keyframes to animate this setting on the ${owner}.`,
  };
}
