import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { applyCommand, EditHistory } from '../../src/shared/commands.js';
import { activeLayerSetting, EMPTY_KEY_VALUES, isKeyframeFrame, KEYFRAME_SETTINGS, keyframeNeighbors, type LayerKeyframe, type LayerKeyValues } from '../../src/shared/keyframes.js';
import { createClip, createProject, projectSchema, type ProjectDocument, type VideoLayer } from '../../src/shared/model.js';
import { Inspector } from '../../src/web/Inspector.js';
import { inspectKeyframe, KeyframeNavigationContext, keyframeNavigationFrame, keySeekHint, previewFrameFor, reconcileKeyframeInspection, type KeyframeNavigation } from '../../src/web/keyframe-navigation.js';
import { KeyframeToggle, type KeyframeToggleProps } from '../../src/web/KeyframeToggle.js';
import { Layers } from '../../src/web/Layers.js';

function point(frame: number, values: Partial<LayerKeyValues>): LayerKeyframe {
  return { frame, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, ...values } };
}

const interleaved = [0, 100, 200].flatMap((start) => KEYFRAME_SETTINGS.map(({ key }, index) => point(start + index * 3, { [key]: key === 'speed' ? 1 : 0 })));

function project(keys = [point(10, { exposure: 0 }), point(60, { exposure: 0.2 }), point(70, { brightness: 0 }), point(80, { exposure: 0.4 }), point(100, { exposure: 0.6 })]): ProjectDocument {
  const document = createProject('navigation', 'Memory-only navigation');
  document.layers[0]!.keyframes = keys;
  document.media.videoIds = ['synthetic'];
  document.clips = [createClip('clip', 'synthetic', 0, 20)];
  return projectSchema.parse(document);
}

function navigation(changes: Partial<KeyframeNavigation> = {}): KeyframeNavigation {
  return { inspection: null, duration: 250, disabled: false, onSeekKeyframe: vi.fn(), onFollowPlayhead: vi.fn(), ...changes };
}

function toggleMarkup(changes: Partial<KeyframeToggleProps> = {}, context = navigation()): string {
  const layer: VideoLayer = { ...createProject('markup', 'Markup').layers[0]!, keyframes: [point(10, { exposure: 0 }), point(15, { brightness: 0 }), point(20, { exposure: 0.4 })] };
  return renderToStaticMarkup(createElement(KeyframeNavigationContext.Provider, { value: context }, createElement(KeyframeToggle, {
    layer, setting: 'exposure', label: 'Exposure', frame: 15, value: 0.2, disabled: false, onEdit: vi.fn(), ...changes,
  })));
}

function buttons(markup: string): string[] {
  return [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
}

describe('ordered per-setting keyframe neighbours', () => {
  it.each(KEYFRAME_SETTINGS)('$label skips every interleaved nonparticipant and uses strict endpoints', ({ key }) => {
    const index = KEYFRAME_SETTINGS.findIndex((setting) => setting.key === key);
    const first = interleaved[index]!; const middle = interleaved[10 + index]!; const last = interleaved[20 + index]!;
    expect(keyframeNeighbors(interleaved, first.frame, key)).toEqual({ previous: null, next: middle });
    expect(keyframeNeighbors(interleaved, first.frame + 1, key)).toEqual({ previous: first, next: middle });
    expect(keyframeNeighbors(interleaved, middle.frame, key)).toEqual({ previous: first, next: last });
    expect(keyframeNeighbors(interleaved, middle.frame + 1, key)).toEqual({ previous: middle, next: last });
    expect(keyframeNeighbors(interleaved, last.frame, key)).toEqual({ previous: middle, next: null });
    expect(keyframeNeighbors(interleaved, last.frame + 1, key)).toEqual({ previous: last, next: null });
    expect(first.values[key]).toBe(key === 'speed' ? 1 : 0);
    expect(keyframeNeighbors(interleaved, middle.frame, key).previous).toBe(first);
  });

  it('navigates a hollow diamond without landing on a point belonging only to another channel', () => {
    const keys = [point(0, { exposure: 0 }), point(10, { brightness: 0 }), point(20, { exposure: 1 })];
    expect(activeLayerSetting({ keyframes: keys }, 'exposure', 10)).toBe(false);
    expect(keyframeNeighbors(keys, 10, 'exposure')).toEqual({ previous: keys[0], next: keys[2] });
    expect(keyframeNeighbors(keys, 10)).toEqual({ previous: keys[0], next: keys[2] });
    expect(keyframeNeighbors(keys, 0)).toEqual({ previous: null, next: keys[1] });
    expect(keyframeNeighbors(keys, 10, 'shadows')).toEqual({ previous: null, next: null });
    expect(keyframeNeighbors([], 10, 'exposure')).toEqual({ previous: null, next: null });
  });

  it.each([-1, 0.5, NaN, Infinity, -Infinity, 2_147_483_648, Number.MAX_SAFE_INTEGER])('invalid navigation frame %s has no neighbours', (frame) => {
    expect(isKeyframeFrame(frame)).toBe(false);
    expect(keyframeNeighbors(interleaved, frame, 'exposure')).toEqual({ previous: null, next: null });
    expect(keyframeNeighbors(interleaved, frame)).toEqual({ previous: null, next: null });
  });

  it('ignores invalid stored frames without mutating or sorting the ordered valid points', () => {
    const first = point(0, { exposure: 0 }); const last = point(2_147_483_647, { exposure: 1 });
    const keys = Object.freeze([point(-1, { exposure: 1 }), first, point(NaN, { exposure: 1 }), point(0.5, { exposure: 1 }), point(Infinity, { exposure: 1 }), last, point(2_147_483_648, { exposure: 1 })]);
    expect(isKeyframeFrame(0)).toBe(true); expect(isKeyframeFrame(last.frame)).toBe(true);
    expect(keyframeNeighbors(keys, 10, 'exposure')).toEqual({ previous: first, next: last });
    expect(keyframeNeighbors(keys, last.frame, 'exposure')).toEqual({ previous: first, next: null });
    expect(keys[1]).toBe(first); expect(keys[5]).toBe(last);
  });
});

describe('one editor-only stored-point cursor', () => {
  it('progresses through several outside-duration keys even though preview stays at the same last frame', () => {
    const document = project(); const layer = document.layers[0]!;
    let cursor = inspectKeyframe(document.id, layer, 60, 0, 20)!;
    expect(cursor.expectedFrame).toBe(19);
    expect(reconcileKeyframeInspection(cursor, document, layer.id, 0, 20, false)).toBe(cursor);
    cursor = reconcileKeyframeInspection(cursor, document, layer.id, 19, 20, false)!;
    expect(cursor.observedFrame).toBe(19);
    for (const frame of [80, 100]) {
      const next = keyframeNeighbors(layer.keyframes, keyframeNavigationFrame(cursor, layer.id, 19), 'exposure').next!;
      expect(next.frame).toBe(frame);
      cursor = inspectKeyframe(document.id, layer, next.frame, 19, 20)!;
      expect(reconcileKeyframeInspection(cursor, document, layer.id, 19, 20, false)).toBe(cursor);
    }
    expect(keyframeNeighbors(layer.keyframes, cursor.frame, 'exposure')).toEqual({ previous: layer.keyframes[3], next: null });
    expect(keyframeNeighbors(layer.keyframes, cursor.frame).previous?.frame).toBe(80);
    cursor = inspectKeyframe(document.id, layer, 70, 19, 20)!;
    expect(keyframeNeighbors(layer.keyframes, cursor.frame, 'exposure').previous?.frame).toBe(60);
    expect(keyframeNeighbors(layer.keyframes, cursor.frame, 'exposure').next?.frame).toBe(80);
    expect(keyframeNavigationFrame(cursor, 'different-row', 19)).toBe(19);
  });

  it('retains stored navigation on an empty timeline without inventing a preview frame', () => {
    const document = { ...project(), clips: [] }; const layer = document.layers[0]!;
    const cursor = inspectKeyframe(document.id, layer, 80, 0, 0)!;
    expect(cursor.frame).toBe(80); expect(cursor.expectedFrame).toBe(0);
    expect(reconcileKeyframeInspection(cursor, document, layer.id, 0, 0, false)).toBe(cursor);
    expect(keyframeNeighbors(layer.keyframes, cursor.frame, 'exposure').next?.frame).toBe(100);
    expect(keySeekHint(80, 0)).toBe('Stored timeline frame 80; the timeline is empty, so there is no frame to preview.');
    expect(activeLayerSetting(layer, 'exposure', 0)).toBe(false);
  });

  it('clears inspection on playback, an external frame, another row/project or closing the project', () => {
    const document = project(); const layer = document.layers[0]!;
    const cursor = inspectKeyframe(document.id, layer, 80, 19, 20)!;
    expect(reconcileKeyframeInspection(cursor, document, layer.id, 19, 20, true)).toBeNull();
    expect(reconcileKeyframeInspection(cursor, document, layer.id, 8, 20, false)).toBeNull();
    expect(reconcileKeyframeInspection(cursor, document, 'other', 19, 20, false)).toBeNull();
    expect(reconcileKeyframeInspection(cursor, { ...document, id: 'other' }, layer.id, 19, 20, false)).toBeNull();
    expect(reconcileKeyframeInspection(cursor, null, layer.id, 19, 20, false)).toBeNull();
    expect(keyframeNavigationFrame(null, layer.id, 19)).toBe(19);
  });

  it('follows a point time edit, its Undo/Redo and duration changes, but not deletion', () => {
    const document = project(); const layer = document.layers[0]!;
    const history = new EditHistory(document);
    let cursor = inspectKeyframe(document.id, layer, 80, 19, 20)!;
    history.commit({ type: 'layer-key-move', layerId: layer.id, frame: 80, nextFrame: 90 });
    cursor = reconcileKeyframeInspection(cursor, history.current, layer.id, 19, 20, false)!;
    expect(cursor.frame).toBe(90);
    cursor = reconcileKeyframeInspection(cursor, history.undo(), layer.id, 19, 20, false)!;
    expect(cursor.frame).toBe(80);
    cursor = reconcileKeyframeInspection(cursor, history.redo(), layer.id, 19, 20, false)!;
    expect(cursor.frame).toBe(90);
    cursor = reconcileKeyframeInspection(cursor, history.current, layer.id, 9, 10, false)!;
    expect(cursor.expectedFrame).toBe(9); expect(cursor.observedFrame).toBe(9);
    history.commit({ type: 'layer-key-remove', layerId: layer.id, frame: 90 });
    expect(reconcileKeyframeInspection(cursor, history.current, layer.id, 9, 10, false)).toBeNull();
    const restored = history.undo();
    expect(reconcileKeyframeInspection(null, restored, layer.id, 19, 20, false)).toBeNull();
    expect(keyframeNeighbors(restored.layers[0]!.keyframes, 19, 'exposure').next?.frame).toBe(60);
  });

  it('keeps an existing shared point after removing one channel, and clears ambiguous removals', () => {
    const document = project([point(10, { exposure: 0 }), point(60, { exposure: 0.2, brightness: 0 }), point(80, { exposure: 0.4 })]);
    const layer = document.layers[0]!; const cursor = inspectKeyframe(document.id, layer, 60, 19, 20)!;
    const changed = applyCommand(document, { type: 'layer-key-toggle', layerId: layer.id, frame: 60, setting: 'exposure', value: 0.2 });
    expect(reconcileKeyframeInspection(cursor, changed, layer.id, 19, 20, false)).toBe(cursor);
    expect(keyframeNeighbors(changed.layers[0]!.keyframes, cursor.frame, 'exposure')).toEqual({ previous: changed.layers[0]!.keyframes[0], next: changed.layers[0]!.keyframes[2] });
    const removed = { ...document, layers: [{ ...layer, keyframes: [point(30, { exposure: 0 }), point(90, { exposure: 1 })] }] };
    expect(reconcileKeyframeInspection(cursor, removed, layer.id, 19, 20, false)).toBeNull();
    expect(reconcileKeyframeInspection(cursor, { ...document, layers: [] }, layer.id, 19, 20, false)).toBeNull();
  });

  it('is read-only: navigation changes neither the strict document nor history or clip bases', () => {
    const document = project(); const history = new EditHistory(document); const before = JSON.stringify(history.current);
    for (const key of history.current.layers[0]!.keyframes) {
      const cursor = inspectKeyframe(document.id, history.current.layers[0]!, key.frame, 19, 20)!;
      reconcileKeyframeInspection(cursor, history.current, 'video-1', 19, 20, false);
      keyframeNeighbors(history.current.layers[0]!.keyframes, cursor.frame, 'exposure');
    }
    expect(JSON.stringify(history.current)).toBe(before);
    expect(history.canUndo).toBe(false); expect(history.canRedo).toBe(false);
    expect(projectSchema.parse(history.current)).toEqual(document);
    expect(history.current.schemaVersion).toBe(6);
  });

  it.each([-1, NaN, Infinity, 0.5, 2_147_483_648])('cannot inspect invalid stored/observed/duration frame %s', (frame) => {
    const document = project(); const layer = document.layers[0]!;
    expect(inspectKeyframe(document.id, layer, frame, 0, 20)).toBeNull();
    expect(inspectKeyframe(document.id, layer, 60, frame, 20)).toBeNull();
    expect(inspectKeyframe(document.id, layer, 60, 0, frame)).toBeNull();
    const cursor = inspectKeyframe(document.id, layer, 60, 0, 20)!;
    expect(reconcileKeyframeInspection(cursor, document, layer.id, frame, 20, false)).toBeNull();
    expect(reconcileKeyframeInspection(cursor, document, layer.id, 0, frame, false)).toBeNull();
  });

  it('does not inspect a missing point and describes the nearest available preview truthfully', () => {
    const document = project();
    expect(inspectKeyframe(document.id, document.layers[0]!, 40, 0, 20)).toBeNull();
    expect(previewFrameFor(10, 20)).toBe(10); expect(previewFrameFor(80, 20)).toBe(19);
    expect(keySeekHint(10, 20)).toBe('Go to timeline frame 10.');
    expect(keySeekHint(20, 20)).toBe('Stored timeline frame 20; preview the nearest available frame 19. The point stays in place.');
  });
});

describe('native diamond, previous, next DOM and all control placements', () => {
  it('renders exactly three sibling native buttons, in diamond/previous/next order, with SVG navigation', () => {
    const markup = toggleMarkup(); const controls = buttons(markup);
    expect(markup.startsWith('<span class="keyframe-setting-navigation" data-animated="true">')).toBe(true);
    expect(markup).toContain('aria-describedby=');
    expect(markup).toContain('Capture a key at the playhead');
    expect(controls).toHaveLength(3);
    expect(controls[0]).toContain('aria-label="Keyframe Exposure"');
    expect(controls[0]).toContain('aria-pressed="false"'); expect(controls[0]).toContain('◇');
    expect(controls[1]).toContain('aria-label="Previous Exposure keyframe"');
    expect(controls[2]).toContain('aria-label="Next Exposure keyframe"');
    for (const control of controls) expect(control).toContain('type="button"');
    for (const control of controls.slice(1)) { expect(control).toContain('<svg'); expect(control).not.toContain('disabled=""'); }
  });

  it('only the diamond requires a finite capture value, not read-only navigation', () => {
    const controls = buttons(toggleMarkup({ value: NaN }));
    expect(controls[0]).toContain('disabled=""');
    expect(controls[1]).not.toContain('disabled=""'); expect(controls[2]).not.toContain('disabled=""');
  });

  it.each(['disabled prop', 'no project / draft context', 'no keys', 'unkeyed channel', 'invalid frame'] as const)('keeps both navigation buttons in the DOM when disabled: %s', (reason) => {
    const layer = { ...createProject('empty', 'Empty').layers[0]!, keyframes: reason === 'no keys' ? [] : [point(10, { exposure: 0 }), point(20, { exposure: 1 })] };
    const controls = buttons(toggleMarkup({
      layer, disabled: reason === 'disabled prop', setting: reason === 'unkeyed channel' ? 'brightness' : 'exposure',
      frame: reason === 'invalid frame' ? NaN : 15,
    }, navigation({ disabled: reason === 'no project / draft context' })));
    expect(controls).toHaveLength(3);
    for (const control of controls.slice(1)) expect(control).toContain('disabled=""');
  });

  it('uses the shared stored-point cursor without presenting a fictional active diamond', () => {
    const layer = { ...createProject('outside', 'Outside').layers[0]!, keyframes: [point(60, { exposure: 0 }), point(80, { exposure: 1 }), point(100, { exposure: 2 })] };
    const inspection = inspectKeyframe('outside', layer, 80, 19, 20)!;
    const controls = buttons(toggleMarkup({ layer, frame: 19 }, navigation({ inspection, duration: 20 })));
    expect(controls[0]).toContain('aria-pressed="false"'); expect(controls[0]).toContain('timeline frame 19');
    expect(controls[1]).toContain('Stored timeline frame 60'); expect(controls[2]).toContain('Stored timeline frame 100');
    expect(controls[1]).toContain('nearest available frame 19');
  });

  it('places both buttons at each of the ten inspector diamonds and retains the duplicate sidebar opacity control', () => {
    const document = project(interleaved);
    const inspector = renderToStaticMarkup(createElement(KeyframeNavigationContext.Provider, { value: navigation() }, createElement(Inspector, {
      project: document, assets: [], selectedClipId: 'clip', selectedLayerId: 'video-1', boundaryId: null,
      frame: 50, drafting: false, section: 'clip', onSection: vi.fn(), onEdit: vi.fn(),
      onPreview: vi.fn(), onSeek: vi.fn(), onPause: vi.fn(),
    })));
    for (const { label } of KEYFRAME_SETTINGS) {
      for (const name of [`Keyframe ${label}`, `Previous ${label} keyframe`, `Next ${label} keyframe`]) {
        expect(inspector.split(`aria-label="${name}"`)).toHaveLength(2);
      }
    }
    const sidebar = renderToStaticMarkup(createElement(KeyframeNavigationContext.Provider, { value: navigation() }, createElement(Layers, {
      project: document, selectedId: 'video-1', scrollTop: 0, surfaceHeight: 198, viewportHeight: 200,
      frame: 50, disabled: false, onScroll: vi.fn(), onSelect: vi.fn(), onEdit: vi.fn(),
    })));
    expect(sidebar).toContain('Layer options Video 1');
    expect(sidebar).toContain('aria-label="Previous Layer opacity keyframe"');
    expect(sidebar).toContain('aria-label="Next Layer opacity keyframe"');
    expect(sidebar).not.toContain('Previous Exposure keyframe');
  });
});
