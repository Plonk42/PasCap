import { z } from 'zod';
import { described } from '../described.js';

export const AUTO_EDIT_PACES = ['calm', 'balanced', 'energetic'] as const;
export const AUTO_EDIT_ORDERS = ['flight', 'energy'] as const;
export const AUTO_EDIT_TRANSITIONS = ['auto', 'cuts', 'soft'] as const;
export const AUTO_EDIT_GRADES = ['match', 'auto', 'none'] as const;
export const MAX_AUTO_EDIT_VARIANT = 99;

export type AutoEditPace = (typeof AUTO_EDIT_PACES)[number];
export type AutoEditOrder = (typeof AUTO_EDIT_ORDERS)[number];
export type AutoEditTransitions = (typeof AUTO_EDIT_TRANSITIONS)[number];
export type AutoEditGrade = (typeof AUTO_EDIT_GRADES)[number];

/** The structured choices of an auto edit, beside the brief. */
export const autoEditChoicesSchema = z
  .object({
    pace: described(
      z.enum(AUTO_EDIT_PACES).default('balanced'),
      'Clip lengths on the music: calm holds shots half as long again, energetic cuts in about half the beats.',
    ),
    order: described(
      z.enum(AUTO_EDIT_ORDERS).default('flight'),
      'flight: shots in the order they were filmed (recording names), an establishing shot first; energy: any order, the liveliest shots on the loudest music.',
    ),
    transitions: described(
      z.enum(AUTO_EDIT_TRANSITIONS).default('auto'),
      'auto: cuts, with dissolves in quiet sections and between alike shots and fades through black in silences; cuts: cuts only; soft: dissolves everywhere but at peaks, fades through black in silences.',
    ),
    grade: described(
      z.enum(AUTO_EDIT_GRADES).default('match'),
      "match: Auto per clip, then every clip matched to the brief's style, else to the clip most like the others; auto: Auto per clip; none: neutral clip grades.",
    ),
    variant: described(
      z.number().int().min(0).max(MAX_AUTO_EDIT_VARIANT).default(0),
      'Which alternative: 0 is the best cut, 1, 2… choose other shots where they score nearly as well.',
    ),
  })
  .strict();
export type AutoEditChoices = z.output<typeof autoEditChoicesSchema>;
export const DEFAULT_AUTO_EDIT_CHOICES: Readonly<AutoEditChoices> = Object.freeze(autoEditChoicesSchema.parse({}));
