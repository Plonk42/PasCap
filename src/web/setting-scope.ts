interface SettingContext {
  keyed: boolean;
  active: boolean;
  baseAvailable: boolean;
  baseLabel: 'Clip' | 'Track';
  /** A clip grade's setting: its frames are source frames and its keyframes the clip's own. */
  clipGrade?: boolean;
  label: string;
  frame: number;
}

/** One vocabulary for the visible tooltip and screen-reader setting context. */
export function settingPresentation({ keyed, active, baseAvailable, clipGrade, label, frame }: SettingContext) {
  const clip = clipGrade === true;
  const at = clip ? `source frame ${frame}` : `timeline frame ${frame}`;
  if (keyed && active)
    return {
      scope: 'Keyframe at playhead',
      hint: `Editable keyframe at ${at}. Edits change only ${label} at this ${clip ? 'clip' : 'shared track'} keyframe.`,
    };
  if (keyed)
    return {
      scope: 'Animated · add a keyframe to edit',
      hint: `Read-only animated value at ${at}. Click the ${label} diamond to add a keyframe here, then edit the value.`,
    };
  if (!baseAvailable)
    return {
      scope: 'No clip selected',
      hint: `Select a clip to edit ${label}, or click the ${label} diamond to animate this setting on the track.`,
    };
  return {
    scope: 'Not animated',
    hint: `Editing ${label}. Add keyframes to animate this setting on the ${clip ? 'clip' : 'track'}.`,
  };
}
