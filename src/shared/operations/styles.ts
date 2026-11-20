import { z } from 'zod';
import { styleSummarySchema } from '../styles.js';
import { defineOperation } from './spec.js';

export const listStyles = defineOperation({
  name: 'list_styles',
  title: 'List styles',
  description:
    "List the styles the user registered from their own finished edits (reference videos or stills), with the file names of their references. estimate kind match with style moves Auto's correction towards a style's tone and color; the session brief may name the style the user wants.",
  input: z.object({}).strict(),
  output: z.object({ styles: z.array(styleSummarySchema) }).strict(),
  access: 'read',
  audience: ['editor', 'assistant'],
});
