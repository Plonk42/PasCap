import { describe, expect, it } from 'vitest';
import { popoverPosition } from '../../src/web/popover-position.js';

describe('shared top-layer popover placement', () => {
    it.each([
        { name: 'below with room', anchor: { right: 900, top: 100, bottom: 124 }, panel: { width: 320, height: 200 }, viewport: { width: 1440, height: 900 }, result: { left: 580, top: 130 } },
        { name: 'above a low anchor', anchor: { right: 900, top: 720, bottom: 744 }, panel: { width: 320, height: 200 }, viewport: { width: 1440, height: 900 }, result: { left: 580, top: 514 } },
        { name: 'left viewport margin', anchor: { right: 32, top: 100, bottom: 124 }, panel: { width: 320, height: 200 }, viewport: { width: 1440, height: 900 }, result: { left: 8, top: 130 } },
        { name: 'right viewport margin', anchor: { right: 1450, top: 100, bottom: 124 }, panel: { width: 320, height: 200 }, viewport: { width: 1440, height: 900 }, result: { left: 1112, top: 130 } },
        { name: 'short viewport', anchor: { right: 500, top: 20, bottom: 44 }, panel: { width: 320, height: 164 }, viewport: { width: 640, height: 180 }, result: { left: 180, top: 8 } },
        { name: 'full available width', anchor: { right: 640, top: 60, bottom: 84 }, panel: { width: 624, height: 200 }, viewport: { width: 640, height: 480 }, result: { left: 8, top: 90 } },
        { name: 'exact lower fit', anchor: { right: 500, top: 66, bottom: 90 }, panel: { width: 320, height: 196 }, viewport: { width: 640, height: 300 }, result: { left: 180, top: 96 } },
        { name: 'one pixel beyond lower fit', anchor: { right: 500, top: 66, bottom: 90 }, panel: { width: 320, height: 197 }, viewport: { width: 640, height: 300 }, result: { left: 180, top: 8 } },
        { name: 'fractional bounds without rounding', anchor: { right: 500.5, top: 66.5, bottom: 90.5 }, panel: { width: 290.25, height: 150.5 }, viewport: { width: 720, height: 480 }, result: { left: 210.25, top: 96.5 } },
    ])('$name', ({ anchor, panel, viewport, result }) => {
        expect(popoverPosition(anchor, panel, viewport)).toEqual(result);
    });

    it('does not mutate captured anchor, panel or viewport measurements', () => {
        const anchor = Object.freeze({ right: 400, top: 100, bottom: 124 });
        const panel = Object.freeze({ width: 290, height: 180 });
        const viewport = Object.freeze({ width: 720, height: 480 });
        expect(popoverPosition(anchor, panel, viewport)).toEqual({ left: 110, top: 130 });
        expect(popoverPosition(anchor, panel, viewport)).toEqual({ left: 110, top: 130 });
    });
});
