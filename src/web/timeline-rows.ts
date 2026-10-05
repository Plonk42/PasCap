import type { VideoLayer } from '../shared/model.js';

export const TIMELINE_RULER_HEIGHT = 31;
const ROW_HEIGHT = 88;
const ROW_TOP = 58;
const LANE_OFFSET = 5;
const LANE_HEIGHT = 78;

export interface TimelineRow {
    layer: VideoLayer;
    /** Saved bottom-to-top composition index, also the displayed row index. */
    index: number;
    top: number;
}

/** Row 1 composites below row 2, then row 3 above row 2, without special roles. */
export function timelineRows(layers: readonly VideoLayer[]): TimelineRow[] {
    return layers.map((layer, index) => ({ layer, index, top: ROW_TOP + index * ROW_HEIGHT }));
}

/** Content-space hit testing shares the exact row geometry used for drawing. */
export function timelineLayerAt(rows: readonly TimelineRow[], y: number): string | null {
    return rows.find((row) => y >= row.top - LANE_OFFSET && y < row.top - LANE_OFFSET + LANE_HEIGHT)?.layer.id ?? null;
}
