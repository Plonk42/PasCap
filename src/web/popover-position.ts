interface Anchor { right: number; top: number; bottom: number }
interface Size { width: number; height: number }
export interface PopoverPosition { left: number; top: number }

/** Top-layer panels stay within the viewport without changing the anchor's layout. */
export function popoverPosition(anchor: Readonly<Anchor>, panel: Readonly<Size>, viewport: Readonly<Size>): PopoverPosition {
    const margin = 8;
    const gap = 6;
    const left = Math.max(margin, Math.min(anchor.right - panel.width, viewport.width - panel.width - margin));
    const below = anchor.bottom + gap;
    const preferredTop = below + panel.height <= viewport.height - margin ? below : anchor.top - panel.height - gap;
    const top = Math.max(margin, Math.min(preferredTop, viewport.height - panel.height - margin));
    return { left, top };
}
