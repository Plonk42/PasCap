import { MAX_VIDEO_LAYERS } from '../shared/model.js';

export type DecoderIndex = 0 | 1;
export type DecoderAssignments = [string | null, string | null];
export type DecoderPoolAssignments = (string | null)[];
export const MAX_DECODER_SLOTS = 2 * MAX_VIDEO_LAYERS;

/** Two simultaneous dissolve sources per track; never one decoder per stored clip. */
export function decoderPoolSize(layerCount: number): number {
  if (!Number.isInteger(layerCount) || layerCount < 0 || layerCount > MAX_VIDEO_LAYERS) throw new Error('Unsupported video layer count.');
  return 2 * layerCount;
}

/** Preserve every required instance, preferring empty slots over speculative sources. */
export function allocateDecoders(current: readonly (string | null)[], required: readonly string[]): DecoderPoolAssignments {
  const active = new Set(required);
  const assigned = current.filter((id) => id !== null);
  if (current.length > MAX_DECODER_SLOTS || required.length > current.length) throw new Error('Required clips exceed the bounded decoder pool.');
  if (active.size !== required.length || new Set(assigned).size !== assigned.length) throw new Error('Decoder assignments must contain distinct clip instances.');
  const next = [...current];
  for (const id of required) {
    if (next.includes(id)) continue;
    let index = next.indexOf(null);
    if (index < 0) index = next.findIndex((clipId) => clipId !== null && !active.has(clipId));
    if (index < 0) throw new Error('No reusable decoder is available.');
    next[index] = id;
  }
  return next;
}

/** Keep active clip instances on their current decoder, evict only an inactive one. */
export function assignDecoders(current: Readonly<DecoderAssignments>, required: readonly string[]): DecoderAssignments {
  if (required.length > 2 || new Set(required).size !== required.length) throw new Error('A frame requires at most two distinct clip instances.');
  const next: DecoderAssignments = [...current];
  for (const id of required) {
    if (next.includes(id)) continue;
    const index = next.findIndex((assigned) => assigned === null || !required.includes(assigned));
    if (index < 0) throw new Error('No reusable decoder is available.');
    next[index] = id;
  }
  return next;
}