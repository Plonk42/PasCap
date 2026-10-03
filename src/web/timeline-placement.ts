import { applyCommand, type EditCommand } from '../shared/commands.js';
import { compileLayerRetiming } from '../shared/layer-retiming.js';
import type { ProjectDocument, VideoClip } from '../shared/model.js';
import { calculateLayout, primaryClips } from '../shared/timeline.js';

export type TimelinePayload = { kind: 'clip'; clipId: string; grabFrame: number } | { kind: 'media'; clips: readonly VideoClip[] };
export interface DropPlan {
    layerId: string;
    start: number;
    duration: number;
    guide: number | null;
    mode: 'ripple' | 'position';
    index: number;
    command: EditCommand | null;
    error: string;
}

/** Match either edge, never pull the moving clip toward its own old boundaries. */
export function snapPlacement(start: number, duration: number, points: readonly number[], tolerance: number): { start: number; guide: number | null } {
    let result = Math.max(0, Math.round(start));
    let guide: number | null = null;
    let closest = tolerance + 1e-8;
    for (const point of points) {
        for (const edge of [0, duration]) {
            const candidate = point - edge;
            if (candidate < 0) continue;
            const distance = Math.abs(candidate - start);
            if (distance < closest) { closest = distance; result = candidate; guide = point; }
        }
    }
    return { start: result, guide };
}

export function placementSnapPoints(project: ProjectDocument, excludedClipId: string | null, playhead: number): number[] {
    const layout = calculateLayout(project);
    const clips = layout.clips.filter((placed) => placed.clip.id !== excludedClipId);
    const transitions = layout.transitions.filter((region) => region.transition.leftId !== excludedClipId && region.transition.rightId !== excludedClipId);
    const points = [0, playhead, ...clips.flatMap((placed) => [placed.start, placed.end]), ...transitions.flatMap((region) => [region.start, region.boundary, region.end])];
    if (project.music) points.push(project.music.start, project.music.start + project.music.duration);
    return [...new Set(points)].filter((point) => point >= 0).sort((left, right) => left - right);
}

interface InsertionSlot { index: number; start: number }
function primarySlots(project: ProjectDocument, payload: TimelinePayload, firstId: string): InsertionSlot[] {
    const clips = payload.kind === 'clip' ? project.clips.filter((clip) => clip.id !== payload.clipId) : project.clips;
    const primary = primaryClips({ ...project, clips });
    // Layout after removal determines the actual ripple positions, not the old
    // positions under the mouse. Fades do not affect placement; validate them on
    // the complete final candidate, never on this temporary remainder.
    const transitions = primary.slice(0, -1).map((left, index) => project.transitions.find((transition) => transition.leftId === left.id && transition.rightId === primary[index + 1]!.id)
        ?? { leftId: left.id, rightId: primary[index + 1]!.id, type: 'cut' as const, duration: 0 as const });
    const layout = calculateLayout({ ...project, clips, transitions, openingFade: 0, closingFade: 0 });
    const placed = layout.clips.filter((item) => item.clip.layerId === project.layers[0]!.id);
    return Array.from({ length: primary.length + 1 }, (_, order) => {
        const left = placed[order - 1];
        const incoming = left && project.transitions.find((transition) => transition.leftId === left.clip.id && transition.rightId === firstId && transition.type === 'cross-dissolve');
        return {
            index: order < primary.length ? clips.findIndex((clip) => clip.id === primary[order]!.id) : clips.length,
            start: left ? left.end - (incoming?.duration ?? 0) : 0
        };
    });
}

function candidateDocument(project: ProjectDocument, payload: TimelinePayload, plan: DropPlan): ProjectDocument {
    if (payload.kind === 'clip') return applyCommand(project, plan.command!);
    let document = project; let cursor = plan.start;
    for (const [offset, clip] of payload.clips.entries()) {
        document = applyCommand(document, { type: 'insert', clip: { ...clip, layerId: plan.layerId, start: plan.mode === 'ripple' ? 0 : cursor }, index: plan.index + offset });
        cursor = calculateLayout(document).clips.find((placed) => placed.clip.id === clip.id)!.end;
    }
    return document;
}

function draggedClips(project: ProjectDocument, payload: TimelinePayload): readonly VideoClip[] {
    if (payload.kind === 'media') {
        if (!payload.clips.length) throw new Error('The dragged clip is unavailable.');
        return payload.clips;
    }
    const clip = project.clips.find((item) => item.id === payload.clipId);
    if (!clip) throw new Error('The dragged clip is unavailable.');
    return [clip];
}

function durationAt(project: ProjectDocument, clips: readonly VideoClip[], layerId: string, start: number): number {
    const layer = project.layers.find((item) => item.id === layerId)!;
    let cursor = start;
    for (const clip of clips) cursor += compileLayerRetiming(clip, layer, cursor).duration;
    return cursor - start;
}

function startEndingAt(point: number, minimum: number, maximum: number, preferred: number, endAt: (start: number) => number): number | null {
    if (point < endAt(minimum) || point > endAt(maximum)) return null;
    let low = minimum; let high = maximum;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (endAt(middle) < point) low = middle + 1;
        else high = middle;
    }
    if (endAt(low) !== point) return null;
    const first = low;
    high = maximum;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (endAt(middle) > point) high = middle - 1;
        else low = middle;
    }
    return Math.max(first, Math.min(low, preferred));
}

/** The trailing edge changes length when it moves across a row rate curve.
 * Solve its actual contextual end instead of snapping with the old width. */
function snapRowPlacement(project: ProjectDocument, clips: readonly VideoClip[], layerId: string, requested: number, points: readonly number[], tolerance: number): { start: number; guide: number | null } {
    let start = requested;
    let guide: number | null = null;
    let closest = tolerance + 1e-8;
    const consider = (candidate: number, point: number): void => {
        const distance = Math.abs(candidate - requested);
        if (candidate >= 0 && distance < closest) { start = candidate; guide = point; closest = distance; }
    };
    const minimum = Math.max(0, requested - Math.ceil(tolerance));
    const maximum = requested + Math.ceil(tolerance);
    const endAt = (candidate: number): number => candidate + durationAt(project, clips, layerId, candidate);
    for (const point of points) {
        consider(point, point);
        const trailing = startEndingAt(point, minimum, maximum, requested, endAt);
        if (trailing !== null) consider(trailing, point);
    }
    return { start, guide };
}

/** Both drag feedback and drop commit consume this same integer-frame plan. */
export function planTimelineDrop(project: ProjectDocument, payload: TimelinePayload, layerId: string, pointerFrame: number, snapping: boolean, tolerance: number, playhead: number): DropPlan {
    if (!project.layers.some((layer) => layer.id === layerId)) throw new Error('Choose a video row before dropping.');
    const clips = draggedClips(project, payload);
    const first = clips[0]!;
    const requested = Math.max(0, Math.round(pointerFrame - (payload.kind === 'clip' ? payload.grabFrame : 0)));
    const mode = layerId === project.layers[0]!.id ? 'ripple' : 'position';
    let index = payload.kind === 'clip' ? project.clips.findIndex((clip) => clip.id === payload.clipId) : project.clips.length;
    let start = requested;
    let guide: number | null = null;
    if (mode === 'ripple') {
        const slots = primarySlots(project, payload, first.id);
        const slot = slots.reduce((nearest, candidate) => Math.abs(candidate.start - requested) < Math.abs(nearest.start - requested) ? candidate : nearest, slots[0]!);
        index = slot.index; start = slot.start;
    } else if (snapping) {
        const snapped = snapRowPlacement(project, clips, layerId, requested, placementSnapPoints(project, payload.kind === 'clip' ? payload.clipId : null, playhead), tolerance);
        start = snapped.start; guide = snapped.guide;
    }
    const duration = durationAt(project, clips, layerId, start);
    const command: EditCommand | null = payload.kind === 'clip' ? { type: 'place', clipId: payload.clipId, layerId, start: mode === 'ripple' ? 0 : start, index } : null;
    const plan: DropPlan = { layerId, start, duration, guide, mode, index, command, error: '' };
    try {
        const candidate = candidateDocument(project, payload, plan);
        const layout = calculateLayout(candidate);
        const placed = layout.clips.find((item) => item.clip.id === first.id)!;
        plan.start = placed.start;
        plan.duration = Math.max(...clips.map((clip) => layout.clips.find((item) => item.clip.id === clip.id)!.end)) - placed.start;
    } catch (cause) { plan.error = cause instanceof Error ? cause.message : 'This placement is not valid.'; }
    return plan;
}