import { describe, expect, it } from 'vitest';
import { popoverPosition } from '../../src/web/popover-position.js';

describe('shared top-layer popover placement', () => {
    it.each([
        { name: 'below with room', anchor: { right: 900, top: 100, bottom: 124 }, panel: { width: 320, height: 200 }, viewport: { width: 1440, height: 900 }, result: { left: 580, top: 130, maxHeight: 762 } },
        { name: 'above a low anchor', anchor: { right: 900, top: 720, bottom: 744 }, panel: { width: 320, height: 200 }, viewport: { width: 1440, height: 900 }, result: { left: 580, top: 514, maxHeight: 706 } },
        { name: 'left viewport margin', anchor: { right: 32, top: 100, bottom: 124 }, panel: { width: 320, height: 200 }, viewport: { width: 1440, height: 900 }, result: { left: 8, top: 130, maxHeight: 762 } },
        { name: 'right viewport margin', anchor: { right: 1450, top: 100, bottom: 124 }, panel: { width: 320, height: 200 }, viewport: { width: 1440, height: 900 }, result: { left: 1112, top: 130, maxHeight: 762 } },
        { name: 'short viewport scrolls below without covering the anchor', anchor: { right: 500, top: 20, bottom: 44 }, panel: { width: 320, height: 164 }, viewport: { width: 640, height: 180 }, result: { left: 180, top: 50, maxHeight: 122 } },
        { name: 'full available width', anchor: { right: 640, top: 60, bottom: 84 }, panel: { width: 624, height: 200 }, viewport: { width: 640, height: 480 }, result: { left: 8, top: 90, maxHeight: 382 } },
        { name: 'exact lower fit', anchor: { right: 500, top: 66, bottom: 90 }, panel: { width: 320, height: 196 }, viewport: { width: 640, height: 300 }, result: { left: 180, top: 96, maxHeight: 196 } },
        { name: 'one pixel beyond lower fit scrolls on the larger side', anchor: { right: 500, top: 66, bottom: 90 }, panel: { width: 320, height: 197 }, viewport: { width: 640, height: 300 }, result: { left: 180, top: 96, maxHeight: 196 } },
        { name: 'fractional bounds without rounding', anchor: { right: 500.5, top: 66.5, bottom: 90.5 }, panel: { width: 290.25, height: 150.5 }, viewport: { width: 720, height: 480 }, result: { left: 210.25, top: 96.5, maxHeight: 375.5 } },
        { name: 'neither side fits and below is larger', anchor: { right: 600, top: 225, bottom: 249 }, panel: { width: 320, height: 312 }, viewport: { width: 640, height: 480 }, result: { left: 280, top: 255, maxHeight: 217 } },
        { name: 'neither side fits and above is larger', anchor: { right: 600, top: 245, bottom: 269 }, panel: { width: 320, height: 500 }, viewport: { width: 640, height: 480 }, result: { left: 280, top: 8, maxHeight: 231 } },
        { name: 'equal space prefers below', anchor: { right: 600, top: 228, bottom: 252 }, panel: { width: 320, height: 500 }, viewport: { width: 640, height: 480 }, result: { left: 280, top: 258, maxHeight: 214 } },
        { name: 'options anchor scrolled above the viewport', anchor: { right: 600, top: -104, bottom: -72 }, panel: { width: 248, height: 300 }, viewport: { width: 640, height: 480 }, result: { left: 352, top: 8, maxHeight: 464 } },
        { name: 'options anchor scrolled below the viewport', anchor: { right: 600, top: 500, bottom: 532 }, panel: { width: 248, height: 300 }, viewport: { width: 640, height: 480 }, result: { left: 352, top: 172, maxHeight: 464 } },
    ])('$name', ({ anchor, panel, viewport, result }) => {
        expect(popoverPosition(anchor, panel, viewport)).toEqual(result);
        const height = Math.min(panel.height, result.maxHeight);
        expect(result.top).toBeGreaterThanOrEqual(8);
        expect(result.top + height).toBeLessThanOrEqual(viewport.height - 8);
        expect(result.top + height <= anchor.top - 6 || result.top >= anchor.bottom + 6).toBe(true);
    });

    it('does not mutate captured anchor, panel or viewport measurements', () => {
        const anchor = Object.freeze({ right: 400, top: 100, bottom: 124 });
        const panel = Object.freeze({ width: 290, height: 180 });
        const viewport = Object.freeze({ width: 720, height: 480 });
        expect(popoverPosition(anchor, panel, viewport)).toEqual({ left: 110, top: 130, maxHeight: 342 });
        expect(popoverPosition(anchor, panel, viewport)).toEqual({ left: 110, top: 130, maxHeight: 342 });
    });

    it('repositions using full content height rather than the previously constrained rectangle', () => {
        const panel = { width: 320, height: 500 };
        expect(popoverPosition({ right: 600, top: 264, bottom: 288 }, panel, { width: 640, height: 480 })).toEqual({ left: 280, top: 8, maxHeight: 250 });
        expect(popoverPosition({ right: 600, top: 407, bottom: 431 }, panel, { width: 640, height: 740 })).toEqual({ left: 280, top: 8, maxHeight: 393 });
        expect(popoverPosition({ right: 600, top: 407, bottom: 431 }, { width: 320, height: 200 }, { width: 640, height: 740 })).toEqual({ left: 280, top: 437, maxHeight: 295 });
    });
});
