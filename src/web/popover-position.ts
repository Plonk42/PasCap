interface Anchor { right: number; top: number; bottom: number }
interface Size { width: number; height: number }
export interface PopoverPosition { left: number; top: number; maxHeight: number }

/** Keep the anchor exposed; a panel taller than either side scrolls on the larger side. */
export function popoverPosition(anchor: Readonly<Anchor>, panel: Readonly<Size>, viewport: Readonly<Size>): PopoverPosition {
    const margin = 8;
    const gap = 6;
    const left = Math.max(margin, Math.min(anchor.right - panel.width, viewport.width - panel.width - margin));
    const bottom = Math.max(margin, viewport.height - margin);
    // Options can remain open while their trigger scrolls outside the viewport.
    const belowStart = Math.max(margin, Math.min(anchor.bottom + gap, bottom));
    const aboveEnd = Math.max(margin, Math.min(anchor.top - gap, bottom));
    const below = bottom - belowStart;
    const above = aboveEnd - margin;
    const useBelow = panel.height <= below || (panel.height > above && below >= above);
    const maxHeight = useBelow ? below : above;
    const top = useBelow ? belowStart : aboveEnd - Math.min(panel.height, maxHeight);
    return { left, top, maxHeight };
}
