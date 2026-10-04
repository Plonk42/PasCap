import { describe, expect, it } from 'vitest';
import { layerActionRestrictions } from '../../src/web/layer-actions.js';

describe('existing layer stack actions and explicit disabled reasons', () => {
    it.each([
        { index: 0, count: 1, enabled: [false, false, false] },
        { index: 0, count: 8, enabled: [false, false, false] },
        { index: 1, count: 2, enabled: [false, false, true] },
        { index: 1, count: 8, enabled: [true, false, true] },
        { index: 3, count: 8, enabled: [true, true, true] },
        { index: 7, count: 8, enabled: [false, true, true] },
    ])('retains allowed actions for index $index of $count', ({ index, count, enabled }) => {
        const reasons = layerActionRestrictions(index, count, false);
        expect([reasons.raise, reasons.lower, reasons.remove].map((reason) => reason === null)).toEqual(enabled);
    });

    it('explains the primary, top and lowest-overlay limits rather than implying these are removable', () => {
        const primary = layerActionRestrictions(0, 8, false);
        expect(primary.raise).toContain('primary sequence stays at the bottom');
        expect(primary.lower).toContain('primary sequence stays at the bottom');
        expect(primary.remove).toContain('Delete its excerpts instead');
        expect(layerActionRestrictions(7, 8, false).raise).toContain('already the top layer');
        expect(layerActionRestrictions(1, 8, false).lower).toContain('cannot move below it');
    });

    it('blocks every otherwise available overlay operation during an active draft or unavailable preview', () => {
        const reasons = layerActionRestrictions(3, 8, true);
        for (const reason of Object.values(reasons)) expect(reason).toContain('Finish or cancel the active edit');
    });
});
