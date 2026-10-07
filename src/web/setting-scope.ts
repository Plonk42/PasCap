interface SettingContext {
  keyed: boolean;
  active: boolean;
  baseAvailable: boolean;
  baseLabel: 'Clip' | 'Layer';
  label: string;
  frame: number;
}

/** One vocabulary for the visible tooltip and screen-reader setting context. */
export function settingPresentation({ keyed, active, baseAvailable, label, frame }: SettingContext) {
  if (keyed && active)
    return {
      scope: 'Keyframe at playhead',
      hint: `Editable keyframe at timeline frame ${frame}. Edits change only ${label} at this shared layer point.`,
    };
  if (keyed)
    return {
      scope: 'Animated · add a keyframe to edit',
      hint: `Read-only animated value at timeline frame ${frame}. Click the ${label} diamond to add a keyframe here, then edit the value.`,
    };
  if (!baseAvailable)
    return {
      scope: 'No clip selected',
      hint: `Select a clip to edit ${label}, or click the ${label} diamond to animate this setting on the row.`,
    };
  return {
    scope: 'Not animated',
    hint: `Editing ${label}. Add keyframes to animate this setting on the row.`,
  };
}
