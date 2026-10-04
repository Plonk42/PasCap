import { describe, expect, it } from 'vitest';
import { createProject } from '../../src/shared/model.js';
import { TIMELINE_RULER_HEIGHT, timelineLayerAt, timelineRows } from '../../src/web/timeline-rows.js';

function layers(count: number) {
    const project = createProject('row-geometry', 'Row geometry');
    for (let index = 2; index <= count; index++) project.layers.push({ id: `row-${index}`, name: `Video ${index}`, enabled: true, opacity: 1, keyframes: [] });
    return project.layers;
}

describe('primary-first editor row geometry is independent of composition', () => {
    it.each([1, 2, 3, 8])('keeps primary first and overlays front-to-back for %i layers without mutating their saved order', (count) => {
        const source = layers(count);
        const before = structuredClone(source);
        const rows = timelineRows(source);
        expect(rows.map((row) => row.index)).toEqual([0, ...Array.from({ length: count - 1 }, (_, index) => count - index - 1)]);
        expect(rows.map((row) => row.top)).toEqual(Array.from({ length: count }, (_, index) => 58 + index * 88));
        expect(source).toEqual(before);
        for (const row of rows) expect(row.layer).toBe(source[row.index]);
    });

    it('uses drawn lane bounds for primary, every overlay, gaps and the music region', () => {
        const rows = timelineRows(layers(8));
        for (const row of rows) {
            expect(timelineLayerAt(rows, row.top - 5)).toBe(row.layer.id);
            expect(timelineLayerAt(rows, row.top + 72)).toBe(row.layer.id);
            expect(timelineLayerAt(rows, row.top + 73)).toBeNull();
            expect(timelineLayerAt(rows, row.top + 82)).toBeNull();
        }
        for (const y of [-1, 0, TIMELINE_RULER_HEIGHT, 52, 759, 814, NaN, Infinity]) expect(timelineLayerAt(rows, y)).toBeNull();
    });

    it('reordering overlay composition keeps primary at the first row and carries each layer identity to its drawn/hit-tested row', () => {
        const source = layers(3);
        [source[1], source[2]] = [source[2]!, source[1]!];
        const rows = timelineRows(source);
        expect(rows.map((row) => row.layer.id)).toEqual(['video-1', 'row-2', 'row-3']);
        expect(rows.map((row) => timelineLayerAt(rows, row.top))).toEqual(['video-1', 'row-2', 'row-3']);
        expect(source.map((layer) => layer.id)).toEqual(['video-1', 'row-3', 'row-2']);
    });
});
