import { MAX_MUSIC_CLIPS, type MusicClip, type MusicLane, type MusicTrack, type MusicTransition } from './model.js';

export type MusicTransitionType = MusicTransition['type'];

/** Frames of a clip's own sound a transition fades: at the end of its left clip ('out') or start of its right ('in'). */
export function musicTransitionFade(transition: MusicTransition | undefined, side: 'in' | 'out'): number {
  if (!transition || transition.type === 'cut') return 0;
  if (transition.type === 'crossfade') return transition.duration;
  if (transition.type === 'fade-silence-pause') return transition.fade;
  // Like a video fade through black: the left clip takes the larger half.
  return side === 'out' ? Math.ceil(transition.duration / 2) : Math.floor(transition.duration / 2);
}

/** Signed frames from the left clip's OUT to the right clip's start: a crossfade overlaps the two clips, a pause leaves its own slot. */
export function musicTransitionOffset(transition: MusicTransition | undefined): number {
  if (transition?.type === 'crossfade') return -transition.duration;
  return transition?.type === 'fade-silence-pause' ? transition.pause : 0;
}

export function musicClipEnd(clip: Pick<MusicClip, 'start' | 'duration'>): number {
  return clip.start + clip.duration;
}

/**
 * The playable sources of the music tracks: every clip with its track's gain and its own fades, the
 * track's opening/closing fade on its first/last clip and each transition's fade on the clips it joins.
 * A crossfade is two linear fades over the same frames, so the mix and export need nothing else.
 */
export function musicTracks(lanes: readonly MusicLane[]): MusicTrack[] {
  return lanes.flatMap((lane) =>
    lane.clips.map((clip, index) => ({
      id: clip.id,
      mediaId: clip.mediaId,
      sourceIn: clip.sourceIn,
      sourceOut: clip.sourceOut,
      start: clip.start,
      duration: clip.duration,
      gainDb: lane.gainDb,
      fadeIn: index === 0 ? lane.openingFade : musicTransitionFade(lane.transitions[index - 1], 'in'),
      fadeOut: index === lane.clips.length - 1 ? lane.closingFade : musicTransitionFade(lane.transitions[index], 'out'),
      loop: clip.loop,
    })),
  );
}

export function musicClips(lanes: readonly MusicLane[]): MusicClip[] {
  return lanes.flatMap((lane) => lane.clips);
}

export function laneOfClip(lanes: readonly MusicLane[], clipId: string): MusicLane | undefined {
  return lanes.find((lane) => lane.clips.some((clip) => clip.id === clipId));
}

function placementError(lane: MusicLane, incoming: MusicTransition): string {
  if (incoming.type === 'crossfade') return 'A music crossfade must overlap its two clips by exactly its duration.';
  if (incoming.type === 'fade-through-silence') return 'A fade through silence requires touching music clips.';
  if (incoming.type === 'fade-silence-pause')
    return 'A music pause must leave exactly its length between its two clips.';
  return lane.ripple
    ? 'A Ripple music track plays its clips one after another without gaps.'
    : 'Music clips on one track cannot overlap except in a crossfade.';
}

/** Throws the first reason a music track's clips, transitions or fades are inconsistent; `index` names the track. */
export function validateMusicLane(lane: MusicLane, index = 0): void {
  if (lane.transitions.length !== lane.clips.length - 1)
    throw new Error('Exactly one transition is required per adjacent music clip pair.');
  for (const [pair, transition] of lane.transitions.entries()) {
    if (transition.leftId !== lane.clips[pair]!.id || transition.rightId !== lane.clips[pair + 1]!.id)
      throw new Error('Music transitions must follow the ordered adjacent clip pairs of their music track.');
  }
  validateMusicPlacement(lane);
  for (const [position, source] of musicTracks([lane]).entries())
    if (source.fadeIn + source.fadeOut > source.duration)
      throw new Error(`Fades and transitions overlap or exceed clip ${position + 1} of music track ${index + 1}.`);
}

function validateMusicPlacement(lane: MusicLane): void {
  for (const [index, clip] of lane.clips.entries()) {
    const previous = lane.clips[index - 1];
    if (!previous) continue;
    const incoming = lane.transitions[index - 1]!;
    const end = musicClipEnd(previous);
    const exact = lane.ripple || incoming.type !== 'cut';
    if (exact ? clip.start !== end + musicTransitionOffset(incoming) : clip.start < end)
      throw new Error(placementError(lane, incoming));
    const earlier = lane.clips[index - 2];
    if (earlier && clip.start < musicClipEnd(earlier))
      throw new Error('A music track cannot contain a triple overlap.');
  }
}

/** Ripple tracks play their clips one after another from the first clip's start; other tracks keep their starts. */
export function sequenceMusicLane(lane: MusicLane): MusicLane {
  if (!lane.ripple) return lane;
  const clips: MusicClip[] = [];
  for (const [index, clip] of lane.clips.entries()) {
    const previous = clips[index - 1];
    clips.push(
      previous ? { ...clip, start: musicClipEnd(previous) + musicTransitionOffset(lane.transitions[index - 1]) } : clip,
    );
  }
  return { ...lane, clips };
}

/** Clips in this order, keeping the transition of every pair that stays adjacent; new pairs are cuts. */
export function arrangeMusicLane(lane: MusicLane, clips: readonly MusicClip[]): MusicLane {
  if (clips.length > MAX_MUSIC_CLIPS)
    throw new Error(`A music track holds at most ${MAX_MUSIC_CLIPS} clips. Add another music track instead.`);
  const transitions = clips
    .slice(1)
    .map(
      (right, index): MusicTransition =>
        lane.transitions.find(
          (transition) => transition.leftId === clips[index]!.id && transition.rightId === right.id,
        ) ?? { leftId: clips[index]!.id, rightId: right.id, type: 'cut', duration: 0 },
    );
  return sequenceMusicLane({ ...lane, clips: [...clips], transitions });
}

/** The insertion index nearest a start frame among clips, by their middles. */
function slotAt(clips: readonly MusicClip[], start: number, duration: number): number {
  const middle = start + duration / 2;
  return clips.filter((clip) => clip.start + clip.duration / 2 <= middle).length;
}

/**
 * Adds a clip: a Ripple track takes it at the sequence slot nearest its start, keeping the track's first
 * start; another track keeps its start and orders its clips by start.
 */
export function insertMusicClip(lane: MusicLane, clip: MusicClip): MusicLane {
  if (!lane.ripple)
    return arrangeMusicLane(
      lane,
      [...lane.clips, clip].sort((left, right) => left.start - right.start),
    );
  const clips = [...lane.clips];
  clips.splice(slotAt(lane.clips, clip.start, clip.duration), 0, clip);
  clips[0] = { ...clips[0]!, start: lane.clips[0]!.start };
  return arrangeMusicLane(lane, clips);
}

/** Removes clips; null when none remain, since a music track holds at least one clip. */
export function removeMusicClips(lane: MusicLane, ids: ReadonlySet<string>): MusicLane | null {
  const clips = lane.clips.filter((clip) => !ids.has(clip.id));
  if (!clips.length) return null;
  if (clips.length === lane.clips.length) return lane;
  // A Ripple track closes the gap from its existing first start.
  clips[0] = { ...clips[0]!, start: lane.ripple ? lane.clips[0]!.start : clips[0]!.start };
  return arrangeMusicLane(lane, clips);
}

/**
 * Moves a clip to `start`: on a Ripple track it takes the nearest sequence slot (moving the track's
 * first start only when it is or becomes the first clip); elsewhere it keeps its start and order by start.
 */
export function moveMusicClip(lane: MusicLane, clipId: string, start: number): MusicLane {
  const moving = lane.clips.find((clip) => clip.id === clipId);
  if (!moving) throw new Error('The music clip is unavailable.');
  const others = lane.clips.filter((clip) => clip.id !== clipId);
  const moved = { ...moving, start };
  if (!lane.ripple)
    return arrangeMusicLane(
      lane,
      [...others, moved].sort((left, right) => left.start - right.start),
    );
  const index = slotAt(others, start, moving.duration);
  const clips = [...others];
  clips.splice(index, 0, moved);
  // Moving the first clip while it stays first moves the sequence; otherwise the first start is kept.
  const anchor = index === 0 && lane.clips[0]!.id === clipId ? start : lane.clips[0]!.start;
  clips[0] = { ...clips[0]!, start: anchor };
  return arrangeMusicLane(lane, clips);
}

/**
 * Sets the transition between clip `index` and the next; without Ripple only the right clip moves.
 * `duration` is the fade of a pause transition, whose silent slot is `pause`.
 */
export function setMusicTransition(
  lane: MusicLane,
  index: number,
  type: MusicTransitionType,
  duration: number,
  pause = 0,
): MusicLane {
  const left = lane.clips[index];
  const right = lane.clips[index + 1];
  if (!left || !right) throw new Error('This music clip has no following clip to join.');
  if (type === 'crossfade' && duration > Math.min(left.duration, right.duration))
    throw new Error('A music crossfade cannot be longer than either clip it joins.');
  const ids = { leftId: left.id, rightId: right.id };
  let transition: MusicTransition;
  if (type === 'fade-silence-pause') transition = { ...ids, type, fade: duration, pause };
  else if (type === 'cut') transition = { ...ids, type, duration: 0 };
  else transition = { ...ids, type, duration };
  const transitions = lane.transitions.map((item, position) => (position === index ? transition : item));
  const previous = lane.transitions[index]!;
  if (lane.ripple || (type === 'cut' && previous.type === 'cut')) return sequenceMusicLane({ ...lane, transitions });
  const clips = lane.clips.map((clip, position) =>
    position === index + 1 ? { ...clip, start: musicClipEnd(left) + musicTransitionOffset(transition) } : clip,
  );
  return { ...lane, clips, transitions };
}

/** Turning Ripple on closes the gaps from the first clip's start; turning it off keeps every start. */
export function setMusicRipple(lane: MusicLane, ripple: boolean): MusicLane {
  return sequenceMusicLane({ ...lane, ripple });
}
