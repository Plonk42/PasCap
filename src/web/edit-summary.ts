import type { EditCommand } from '../shared/commands.js';

/** What a command did, as a noun and a past participle; the plural defaults to the noun plus "s", null for no count. */
type Phrase = readonly [noun: string, verb: string, plural?: string | null];

const PHRASES: Record<EditCommand['type'], Phrase> = {
  insert: ['clip', 'added'],
  delete: ['clip', 'deleted'],
  reorder: ['clip order', 'changed', 'clip orders'],
  trim: ['clip', 'trimmed'],
  'trim-place': ['clip', 'trimmed'],
  split: ['clip', 'split'],
  'remove-source-range': ['part of a clip', 'cut', 'parts of clips'],
  duplicate: ['clip', 'duplicated'],
  colour: ['track Colour', 'changed', 'track Colours'],
  speed: ['clip speed', 'changed', 'clip speeds'],
  reverse: ['clip direction', 'changed', 'clip directions'],
  transform: ['track Transform', 'changed', 'track Transforms'],
  detail: ['clip detail', 'changed', 'clip details'],
  music: ['music', 'changed', null],
  opacity: ['track Opacity', 'changed', 'track Opacities'],
  'layer-key-toggle': ['keyframe setting', 'toggled'],
  'layer-key-value': ['keyframe value', 'changed'],
  'layer-key-move': ['keyframe', 'moved'],
  'layer-key-remove': ['keyframe', 'removed'],
  'layer-key-default': ['default keyframe', 'toggled'],
  'layer-key-easing': ['keyframe Easing', 'changed', 'keyframe Easings'],
  'layer-add': ['track', 'added'],
  'layer-update': ['track', 'changed'],
  'layer-remove': ['track', 'deleted'],
  'layer-order': ['track order', 'changed', 'track orders'],
  place: ['clip', 'moved'],
  'move-clips': ['group of clips', 'moved', 'groups of clips'],
  transition: ['transition', 'changed'],
  fades: ['track fade', 'changed'],
  'bookmark-add': ['bookmark', 'added'],
  'bookmark-move': ['bookmark', 'moved'],
  'bookmark-remove': ['bookmark', 'removed'],
  'select-set': ['kept range', 'changed'],
  'select-narrow': ['kept range', 'narrowed'],
};

/**
 * A batch's command types (the session log's comma-separated summary) in plain words, repeated
 * commands counted: "4 keyframe values changed, bookmark added".
 */
export function describeEdit(summary: string): string {
  const counts = new Map<string, { phrase: Phrase | null; count: number }>();
  for (const type of summary.split(', ').filter(Boolean)) {
    const phrase = Object.hasOwn(PHRASES, type) ? PHRASES[type as EditCommand['type']] : null;
    const entry = counts.get(type) ?? { phrase, count: 0 };
    entry.count++;
    counts.set(type, entry);
  }
  return [...counts]
    .map(([type, { phrase, count }]) => {
      if (!phrase) return count > 1 ? `${count} × ${type}` : type;
      const [noun, verb, plural = `${noun}s`] = phrase;
      return count > 1 && plural !== null ? `${count} ${plural} ${verb}` : `${noun} ${verb}`;
    })
    .join(', ');
}
