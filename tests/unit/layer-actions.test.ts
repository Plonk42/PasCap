import { describe, expect, it } from 'vitest';
import { layerActionRestrictions } from '../../src/web/layer-actions.js';

describe('existing layer stack actions and explicit disabled reasons', () => {
  it.each([
    { index: 0, count: 1, enabled: [false, false, false] },
    { index: 0, count: 8, enabled: [true, false, true] },
    { index: 1, count: 2, enabled: [false, true, true] },
    { index: 1, count: 8, enabled: [true, true, true] },
    { index: 3, count: 8, enabled: [true, true, true] },
    { index: 7, count: 8, enabled: [false, true, true] },
  ])('retains allowed actions for index $index of $count', ({ index, count, enabled }) => {
    const reasons = layerActionRestrictions(index, count, false);
    expect([reasons.raise, reasons.lower, reasons.remove].map((reason) => reason === null)).toEqual(enabled);
  });

  it('explains only the actual composition ends and last-track removal guard', () => {
    const bottom = layerActionRestrictions(0, 8, false);
    expect(bottom.raise).toBeNull();
    expect(bottom.lower).toContain('already the bottom composition layer');
    expect(bottom.remove).toBeNull();
    expect(layerActionRestrictions(7, 8, false).raise).toContain('already the top composition layer');
    expect(layerActionRestrictions(1, 8, false).lower).toBeNull();
    expect(layerActionRestrictions(0, 1, false).remove).toContain('Keep at least one video track');
  });

  it('blocks every otherwise available overlay operation during an active draft or unavailable preview', () => {
    const reasons = layerActionRestrictions(3, 8, true);
    for (const reason of Object.values(reasons)) expect(reason).toContain('Finish or cancel the active edit');
  });
});
