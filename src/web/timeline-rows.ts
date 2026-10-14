import type { VideoLayer } from '../shared/model.js';

export const TIMELINE_RULER_HEIGHT = 31;
/** Clip top inside its lane; the lane and its track header share one box. */
export const LANE_OFFSET = 5;
export const LANE_HEIGHT = 78;
const ROW_TOP = TIMELINE_RULER_HEIGHT + LANE_OFFSET;

export interface TimelineRow {
  layer: VideoLayer;
  /** Saved bottom-to-top composition index, also the displayed row index. */
  index: number;
  /** Clip top; its lane and track header start LANE_OFFSET above. */
  top: number;
}

/** Row 1 composites below row 2, then row 3 above row 2, without special roles. */
export function timelineRows(layers: readonly VideoLayer[]): TimelineRow[] {
  return layers.map((layer, index) => ({ layer, index, top: ROW_TOP + index * LANE_HEIGHT }));
}

/** Music lanes follow the last video lane directly. */
export function musicLanesTop(layerCount: number): number {
  return TIMELINE_RULER_HEIGHT + layerCount * LANE_HEIGHT;
}

/** Content-space hit testing shares the exact row geometry used for drawing. */
export function timelineLayerAt(rows: readonly TimelineRow[], y: number): string | null {
  return rows.find((row) => y >= row.top - LANE_OFFSET && y < row.top - LANE_OFFSET + LANE_HEIGHT)?.layer.id ?? null;
}
