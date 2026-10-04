import type { VideoLayer } from '../shared/model.js';

export const TIMELINE_RULER_HEIGHT = 31;
const ROW_HEIGHT = 88;
const ROW_TOP = 58;
const LANE_OFFSET = 5;
const LANE_HEIGHT = 78;

export interface TimelineRow {
    layer: VideoLayer;
    /** Saved composition index, never the displayed row number. */
    index: number;
    top: number;
}

/** Primary first; overlays below it retain their front-to-back display order.
 * This editor-only ordering never mutates the saved bottom-to-top composition. */
export function timelineRows(layers: readonly VideoLayer[]): TimelineRow[] {
    const [primary, ...overlays] = layers.map((layer, index) => ({ layer, index }));
    if (!primary) return [];
    overlays.reverse();
    return [primary, ...overlays].map((entry, row) => ({ ...entry, top: ROW_TOP + row * ROW_HEIGHT }));
}

/** Content-space hit testing shares the exact row geometry used for drawing. */
export function timelineLayerAt(rows: readonly TimelineRow[], y: number): string | null {
    return rows.find((row) => y >= row.top - LANE_OFFSET && y < row.top - LANE_OFFSET + LANE_HEIGHT)?.layer.id ?? null;
}
