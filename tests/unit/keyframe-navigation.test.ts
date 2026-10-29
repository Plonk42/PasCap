import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { COLOUR_CONTROLS } from '../../src/shared/colour.js';
import { createAdjustment, layerKeyAsGradeKey } from '../../src/shared/grade.js';
import {
  activeLayerSetting,
  EMPTY_KEY_VALUES,
  isKeyframeFrame,
  KEYFRAME_SETTINGS,
  keyframeNeighbors,
  type LayerKeyframe,
  type LayerKeyValues,
  layerKeyframe,
  uniformKeyframe,
} from '../../src/shared/keyframes.js';
import { createClip, createProject, projectSchema, type ProjectDocument } from '../../src/shared/model.js';
import { Inspector } from '../../src/web/Inspector.js';
import { ChannelKeyframeNavigation, TrackAnimationControls } from '../../src/web/AnimationControls.js';
import { adjustmentColourOwner, type ColourOwner } from '../../src/web/colour-owner.js';
import {
  KeyframeNavigationContext,
  keyframeNavigationFrame,
  keySeekHint,
  previewFrameFor,
  type KeyframeNavigation,
} from '../../src/web/keyframe-navigation.js';
import { KeyframeToggle, type KeyframeToggleProps } from '../../src/web/KeyframeToggle.js';
import { Layers } from '../../src/web/Layers.js';
import { SPATIAL_CONTROLS } from '../../src/web/spatial-editor.js';

function point(frame: number, values: Partial<LayerKeyValues>): LayerKeyframe {
  return layerKeyframe(frame, { ...EMPTY_KEY_VALUES, ...values }, 'linear');
}

const interleaved = [0, 100, 200].flatMap((start) =>
  KEYFRAME_SETTINGS.map(({ key }, index) => point(start + index * 3, { [key]: 0 })),
);
/** The interleaved keyframes of every scalar Colour setting, as an adjustment stores them. */
const gradeInterleaved = interleaved.filter((key) => key.values.opacity === null).map(layerKeyAsGradeKey);

/** An adjustment from project frame 0, as the Colour controls edit it: its keyframe frames are timeline frames. */
function owner(keyframes: LayerKeyframe[]): ColourOwner {
  const item = { ...createAdjustment('look', 0, 1_000), keyframes: keyframes.map(layerKeyAsGradeKey) };
  return adjustmentColourOwner(item, 'Look');
}

function project(): ProjectDocument {
  const document = createProject('navigation', 'Memory-only navigation');
  document.media.videoIds = ['synthetic'];
  document.clips = [createClip('clip', 'synthetic', 0, 20)];
  document.adjustments = [{ ...createAdjustment('look', 0, 1_000), keyframes: gradeInterleaved }];
  return projectSchema.parse(document);
}

function navigation(changes: Partial<KeyframeNavigation> = {}): KeyframeNavigation {
  return {
    inspection: null,
    duration: 250,
    disabled: false,
    onSeekKeyframe: vi.fn(),
    onFollowPlayhead: vi.fn(),
    ...changes,
  };
}

function toggleMarkup(changes: Partial<KeyframeToggleProps> = {}, context = navigation()): string {
  const layer = owner([point(10, { exposure: 0 }), point(15, { brightness: 0 }), point(20, { exposure: 0.4 })]);
  return renderToStaticMarkup(
    createElement(
      KeyframeNavigationContext.Provider,
      { value: context },
      createElement(KeyframeToggle, {
        layer,
        setting: 'exposure',
        label: 'Exposure',
        frame: 15,
        value: 0.2,
        disabled: false,
        onEdit: vi.fn(),
        ...changes,
      }),
    ),
  );
}

function buttons(markup: string): string[] {
  return [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
}

function channelMarkup(
  changes: Partial<ComponentProps<typeof ChannelKeyframeNavigation>> = {},
  context = navigation(),
): string {
  const layer = owner([point(10, { exposure: 0 }), point(15, { brightness: 0 }), point(20, { exposure: 0.4 })]);
  return renderToStaticMarkup(
    createElement(
      KeyframeNavigationContext.Provider,
      { value: context },
      createElement(ChannelKeyframeNavigation, {
        layer,
        setting: 'exposure',
        label: 'Exposure',
        frame: 15,
        disabled: false,
        ...changes,
      }),
    ),
  );
}

describe('ordered per-setting keyframe neighbours', () => {
  it.each(KEYFRAME_SETTINGS)('$label skips every interleaved nonparticipant and uses strict endpoints', ({ key }) => {
    const index = KEYFRAME_SETTINGS.findIndex((setting) => setting.key === key);
    const first = interleaved[index]!;
    const middle = interleaved[KEYFRAME_SETTINGS.length + index]!;
    const last = interleaved[KEYFRAME_SETTINGS.length * 2 + index]!;
    expect(keyframeNeighbors(interleaved, first.frame, key)).toEqual({ previous: null, next: middle });
    expect(keyframeNeighbors(interleaved, first.frame + 1, key)).toEqual({ previous: first, next: middle });
    expect(keyframeNeighbors(interleaved, middle.frame, key)).toEqual({ previous: first, next: last });
    expect(keyframeNeighbors(interleaved, middle.frame + 1, key)).toEqual({ previous: middle, next: last });
    expect(keyframeNeighbors(interleaved, last.frame, key)).toEqual({ previous: middle, next: null });
    expect(keyframeNeighbors(interleaved, last.frame + 1, key)).toEqual({ previous: last, next: null });
    expect(first.values[key]).toBe(0);
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

  it.each([-1, 0.5, NaN, Infinity, -Infinity, 2_147_483_648, Number.MAX_SAFE_INTEGER])(
    'invalid navigation frame %s has no neighbours',
    (frame) => {
      expect(isKeyframeFrame(frame)).toBe(false);
      expect(keyframeNeighbors(interleaved, frame, 'exposure')).toEqual({ previous: null, next: null });
      expect(keyframeNeighbors(interleaved, frame)).toEqual({ previous: null, next: null });
    },
  );

  it('ignores invalid stored frames without mutating or sorting the ordered valid points', () => {
    const first = point(0, { exposure: 0 });
    const last = point(2_147_483_647, { exposure: 1 });
    const keys = Object.freeze([
      point(-1, { exposure: 1 }),
      first,
      point(NaN, { exposure: 1 }),
      point(0.5, { exposure: 1 }),
      point(Infinity, { exposure: 1 }),
      last,
      point(2_147_483_648, { exposure: 1 }),
    ]);
    expect(isKeyframeFrame(0)).toBe(true);
    expect(isKeyframeFrame(last.frame)).toBe(true);
    expect(keyframeNeighbors(keys, 10, 'exposure')).toEqual({ previous: first, next: last });
    expect(keyframeNeighbors(keys, last.frame, 'exposure')).toEqual({ previous: first, next: null });
    expect(keys[1]).toBe(first);
    expect(keys[5]).toBe(last);
  });
});

describe('stored keyframe preview hints', () => {
  it('describes the nearest available preview truthfully, including on an empty timeline', () => {
    expect(previewFrameFor(10, 20)).toBe(10);
    expect(previewFrameFor(80, 20)).toBe(19);
    expect(previewFrameFor(80, 0)).toBe(0);
    expect(keySeekHint(10, 20)).toBe('Go to timeline frame 10.');
    expect(keySeekHint(20, 20)).toBe(
      'Stored timeline frame 20; preview the nearest available frame 19. The keyframe stays in place.',
    );
    expect(keySeekHint(80, 0)).toBe(
      'Stored timeline frame 80; the timeline is empty, so there is no frame to preview.',
    );
    expect(keyframeNavigationFrame(null, 'look', 19)).toBe(19);
  });
});

describe('main diamonds with per-setting arrows and stored-channel navigation', () => {
  it('renders the native diamond before its pair of SVG channel buttons with the same stored-chip names', () => {
    const markup = toggleMarkup();
    const controls = buttons(markup);
    expect(markup.startsWith('<span class="keyframe-setting-navigation" data-animated="true">')).toBe(true);
    expect(markup).toContain('aria-describedby=');
    expect(markup).toContain('Capture a keyframe at the playhead');
    expect(controls).toHaveLength(3);
    expect(controls[0]).toContain('aria-label="Keyframe Exposure"');
    expect(controls[0]).toContain('aria-pressed="false"');
    expect(controls[0]).toContain('◇');
    expect(markup).toContain('<span class="channel-keyframe-navigation">');
    expect(controls[1]).toContain('aria-label="Previous Exposure keyframe"');
    expect(controls[2]).toContain('aria-label="Next Exposure keyframe"');
    expect(controls[1]).toContain('title="Go to timeline frame 10."');
    expect(controls[2]).toContain('title="Go to timeline frame 20."');
    const channel = buttons(channelMarkup());
    expect(channel).toHaveLength(2);
    expect(channel[0]).toContain('aria-label="Previous Exposure keyframe"');
    expect(channel[1]).toContain('aria-label="Next Exposure keyframe"');
    for (const control of [...controls, ...channel]) expect(control).toContain('type="button"');
    expect(controls.slice(1)).toEqual(channel);
    for (const control of [...controls.slice(1), ...channel]) {
      expect(control).toContain('<svg');
      expect(control).not.toContain('disabled=""');
      expect(control).toContain('aria-disabled="false"');
      expect(control).toContain('tabindex="0"');
    }
  });

  it('only the diamond requires a finite capture value, not read-only navigation', () => {
    const controls = buttons(toggleMarkup({ value: NaN }));
    expect(controls).toHaveLength(3);
    expect(controls[0]).toContain('disabled=""');
    for (const control of [...controls.slice(1), ...buttons(channelMarkup())]) {
      expect(control).not.toContain('disabled=""');
      expect(control).toContain('aria-disabled="false"');
      expect(control).toContain('tabindex="0"');
    }
  });

  it.each(['disabled prop', 'no project / draft context', 'no keys', 'unkeyed channel', 'invalid frame'] as const)(
    'keeps both navigation buttons in the DOM when disabled: %s',
    (reason) => {
      const layer = owner(reason === 'no keys' ? [] : [point(10, { exposure: 0 }), point(20, { exposure: 1 })]);
      const props = {
        layer,
        disabled: reason === 'disabled prop',
        setting: reason === 'unkeyed channel' ? ('brightness' as const) : ('exposure' as const),
        frame: reason === 'invalid frame' ? NaN : 15,
      };
      const context = navigation({ disabled: reason === 'no project / draft context' });
      const controls = buttons(channelMarkup(props, context));
      expect(controls).toHaveLength(2);
      const main = buttons(toggleMarkup(props, context));
      expect(main).toHaveLength(3);
      expect(main.slice(1)).toEqual(controls);
      for (const control of [...controls, ...main.slice(1)]) {
        expect(control).toContain('aria-disabled="true"');
        expect(control).toContain('tabindex="-1"');
        expect(control).not.toContain('disabled=""');
      }
    },
  );

  it('uses the playhead frame, with strict bounds and zero-valued participants', () => {
    const layer = owner([
      point(0, { exposure: 0 }),
      point(10, { brightness: 0 }),
      point(2_147_483_647, { exposure: 1 }),
    ]);
    const first = buttons(channelMarkup({ layer, frame: 0 }));
    expect(first[0]).toContain('aria-disabled="true"');
    expect(first[0]).toContain('tabindex="-1"');
    expect(first[1]).toContain('Stored timeline frame 2147483647;');
    const last = buttons(channelMarkup({ layer, frame: 2_147_483_647 }));
    expect(last[0]).toContain('Go to timeline frame 0.');
    expect(last[0]).not.toContain('disabled=""');
    expect(last[0]).toContain('aria-disabled="false"');
    expect(last[0]).toContain('tabindex="0"');
    expect(last[1]).toContain('aria-disabled="true"');
    expect(last[1]).toContain('tabindex="-1"');
  });

  it('retains both channel arrows and endpoint disabling on an empty timeline', () => {
    const layer = owner([point(30, { exposure: 0 }), point(45, { brightness: 0 }), point(60, { exposure: 1 })]);
    const first = buttons(channelMarkup({ layer, frame: 30 }, navigation({ duration: 0 })));
    expect(first[0]).toContain('aria-disabled="true"');
    expect(first[0]).toContain('tabindex="-1"');
    expect(first[1]).toContain('Stored timeline frame 60; the timeline is empty');
    const last = buttons(channelMarkup({ layer, frame: 60 }, navigation({ duration: 0 })));
    expect(last[0]).toContain('Stored timeline frame 30; the timeline is empty');
    expect(last[1]).toContain('aria-disabled="true"');
    expect(last[1]).toContain('tabindex="-1"');
    expect(buttons(toggleMarkup({ layer, frame: 60 }, navigation({ duration: 0 }))).slice(1)).toEqual(last);
  });

  it('retains per-setting arrows beside main diamonds and on chips, with one section union and no sidebar duplicates', () => {
    const document = project();
    document.layers[0]!.transform.keyframes = [0, 20].map((frame) => ({
      ...uniformKeyframe(frame, { ...document.layers[0]!.transform.base }, 'linear'),
      reset: false,
    }));
    const inspector = renderToStaticMarkup(
      createElement(
        KeyframeNavigationContext.Provider,
        { value: navigation() },
        createElement(Inspector, {
          project: document,
          assets: [],
          selectedClipId: 'clip',
          selectedLayerId: 'video-1',
          boundaryId: null,
          frame: 50,
          drafting: false,
          section: 'clip',
          sectionRequest: { section: 'colour', colourTarget: 'adjustment', nonce: 1 },
          onSection: vi.fn(),
          onSelectBoundary: vi.fn(),
          onEdit: vi.fn(),
          onPreview: vi.fn(),
          onSeek: vi.fn(),
          onPause: vi.fn(),
          onCollapse: vi.fn(),
          collapseDisabled: false,
        }),
      ),
    );
    for (const { label } of COLOUR_CONTROLS) {
      expect(inspector.split(`aria-label="Keyframe ${label}"`)).toHaveLength(2);
      // One main pair and three stored participants.
      for (const direction of ['Previous', 'Next'])
        expect(inspector.split(`aria-label="${direction} ${label} keyframe"`)).toHaveLength(5);
    }
    const diamonds = [
      ...inspector.matchAll(/<span class="keyframe-setting-navigation"[\s\S]*?<\/button><\/span><\/span>/g),
    ];
    // Each scalar Colour setting of the adjustment, the clip Speed diamond and each Transform setting.
    expect(diamonds).toHaveLength(COLOUR_CONTROLS.length + 1 + SPATIAL_CONTROLS.length);
    const speedDiamond = diamonds.findIndex(([markup]) => markup.includes('aria-label="Keyframe Speed"'));
    // The single-setting Speed section relies on its keyframe-line pair, without a duplicate per-setting pair.
    expect(buttons(diamonds.splice(speedDiamond, 1)[0]![0])).toHaveLength(1);
    for (const direction of ['Previous', 'Next'])
      expect(inspector.split(`aria-label="${direction} Speed keyframe"`)).toHaveLength(2);
    for (const { key, label } of SPATIAL_CONTROLS) {
      // Each Transform setting has one diamond with one Previous/Next pair, like Colour, plus one per stored chip.
      const chips = document.layers[0]!.transform.keyframes.filter((point) => point.values[key] !== null).length;
      expect(inspector.split(`aria-label="Keyframe ${label}"`)).toHaveLength(2);
      for (const direction of ['Previous', 'Next'])
        expect(inspector.split(`aria-label="${direction} ${label} keyframe"`)).toHaveLength(2 + chips);
    }
    expect(inspector).not.toContain('Transform keyframe at displayed source frame');
    for (const [markup] of diamonds) {
      const controls = buttons(markup);
      expect(controls).toHaveLength(3);
      const label = /aria-label="Keyframe ([^"]+)"/.exec(controls[0]!)![1];
      expect(markup).toContain('<span class="channel-keyframe-navigation">');
      expect(controls[1]).toContain(`aria-label="Previous ${label} keyframe"`);
      expect(controls[2]).toContain(`aria-label="Next ${label} keyframe"`);
    }
    // The adjustment's stored list ends before Transform's.
    const colourList = inspector.slice(
      inspector.indexOf('aria-label="Adjustment keyframes'),
      inspector.indexOf('aria-label="Transform keyframes'),
    );
    const chips = [...colourList.matchAll(/<span class="layer-keyframe-chip"[\s\S]*?<\/button><\/span><\/span>/g)];
    expect(chips).toHaveLength(gradeInterleaved.length);
    for (const [markup] of chips) expect(buttons(markup)).toHaveLength(2);
    const sections = [...inspector.matchAll(/<div class="[^"]*section-keyframe-line">[\s\S]*?<\/div>/g)];
    expect(sections).toHaveLength(3);
    expect(inspector).not.toContain('Animate ');
    for (const label of ['Colour', 'Speed', 'Transform']) {
      const section = sections.find(([markup]) => markup.includes(`aria-label="Next ${label} keyframe"`))![0];
      expect(section).toMatch(/\d+ keyframes?/);
      for (const direction of ['Previous', 'Next'])
        expect(section.split(`aria-label="${direction} ${label} keyframe"`)).toHaveLength(2);
    }
    const sidebar = renderToStaticMarkup(
      createElement(
        KeyframeNavigationContext.Provider,
        { value: navigation() },
        createElement(Layers, {
          project: document,
          selectedId: 'video-1',
          scrollTop: 0,
          surfaceHeight: 198,
          viewportHeight: 200,
          disabled: false,
          onScroll: vi.fn(),
          onSelect: vi.fn(),
          onSelectClips: vi.fn(),
          onEdit: vi.fn(),
          onAdd: vi.fn(),
          addAdjustment: { available: false, title: 'Select a range first.' },
          onAddAdjustment: vi.fn(),
        }),
      ),
    );
    expect(sidebar).toContain('Track options Track 1');
    expect(COLOUR_CONTROLS).toHaveLength(14);
    expect(SPATIAL_CONTROLS.map((control) => control.key)).toContain('opacity');
    expect(inspector).toContain('aria-label="Keyframe Opacity"');
    expect(inspector).not.toContain('Keyframe Track opacity');
    expect(inspector).not.toContain('Keyframe Clip opacity');
    expect(sidebar).not.toContain('Track opacity');
    expect(buttons(sidebar).join('')).not.toContain('keyframe');
    expect(sidebar).not.toContain('Previous Exposure keyframe');
  });
});

describe('Colour section union navigation', () => {
  it.each([0, 10, 20, 30, 40, 2_147_483_647])('visits every scalar Colour setting from frame %s', (frame) => {
    const layer = owner([point(0, { exposure: 0 }), point(20, { temperature: 0, tint: 0 }), point(40, { shadows: 0 })]);
    const settings = COLOUR_CONTROLS.map(({ key }) => key);
    const expected = keyframeNeighbors(layer.keyframes, frame);
    const context = navigation();
    const markup = renderToStaticMarkup(
      createElement(
        KeyframeNavigationContext.Provider,
        { value: context },
        createElement(TrackAnimationControls, {
          label: 'Colour',
          layer,
          frame,
          settings,
          disabled: false,
        }),
      ),
    );
    const controls = buttons(markup);
    expect(controls).toHaveLength(2);
    expect(markup).toContain('3 keyframes');
    expect(controls[0]).toContain('aria-label="Previous Colour keyframe"');
    expect(controls[1]).toContain('aria-label="Next Colour keyframe"');
    expect(controls[0]!.includes('disabled=""')).toBe(expected.previous === null);
    expect(controls[1]!.includes('disabled=""')).toBe(expected.next === null);
  });
});
