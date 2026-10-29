import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createAdjustment, layerKeyAsGradeKey } from '../../src/shared/grade.js';
import { EMPTY_KEY_VALUES, KEYFRAME_SETTINGS, layerKeyframe } from '../../src/shared/keyframes.js';
import { createClip, createProject, type ProjectDocument } from '../../src/shared/model.js';
import { adjustmentColourOwner, clipColourOwner } from '../../src/web/colour-owner.js';
import { Inspector } from '../../src/web/Inspector.js';
import { KeyframeNavigationContext } from '../../src/web/keyframe-navigation.js';
import { ColourKeyframeList } from '../../src/web/ColourKeyframeList.js';
import { RangeSettingControl } from '../../src/web/SettingValueControl.js';

const navigation = {
  inspection: null,
  duration: 0,
  disabled: false,
  onSeekKeyframe: vi.fn(),
  onFollowPlayhead: vi.fn(),
};

describe('dedicated Inspector keyframe controls', () => {
  it('labels Clip, Colour, Track and Audio panels; an empty track keeps Opacity in Transform and Colour grades adjustments', () => {
    const render = (project: ProjectDocument): string =>
      renderToStaticMarkup(
        createElement(
          KeyframeNavigationContext.Provider,
          { value: navigation },
          createElement(Inspector, {
            project,
            assets: [],
            selectedClipId: null,
            selectedLayerId: project.layers[0]!.id,
            boundaryId: null,
            frame: 0,
            drafting: false,
            section: 'track',
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
    const panelsOf = (markup: string) => {
      const panels = [...markup.matchAll(/<div role="tabpanel"[^>]*>/g)].map((match) => match[0]);
      expect(panels).toHaveLength(4);
      return {
        panels,
        clip: markup.slice(markup.indexOf(panels[0]!), markup.indexOf(panels[1]!)),
        colour: markup.slice(markup.indexOf(panels[1]!), markup.indexOf(panels[2]!)),
        track: markup.slice(markup.indexOf(panels[2]!), markup.indexOf(panels[3]!)),
      };
    };
    const project = createProject('tabs', 'Tabs');
    const markup = render(project);
    const tabs = [...markup.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g)].map((match) => match[1]);
    expect(tabs).toEqual(['Clip', 'Colour', 'Track', 'Audio']);
    expect(markup).not.toContain('Whole video row');
    expect(markup).not.toContain('Row colour');
    const { panels, clip: clipPanel, colour: colourPanel, track: trackPanel } = panelsOf(markup);
    expect(panels[2]).not.toContain('hidden');
    expect(panels.filter((panel) => panel.includes('hidden'))).toHaveLength(3);
    expect(clipPanel).toContain('Select a clip on Track 1 to edit it.');
    expect(clipPanel).not.toContain('aria-label="Placement section"');
    expect(clipPanel).not.toContain('Opacity');
    // Without a selected clip, the Colour tab grades adjustments; the clip grade is unavailable.
    const target = (label: string) =>
      new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(colourPanel)?.[0] ?? '';
    expect(colourPanel).toContain('aria-label="Colour target"');
    expect(target('Clip grade')).toContain('aria-disabled="true"');
    expect(target('Adjustment')).toContain('aria-checked="true"');
    expect(colourPanel).toContain('>No adjustment</strong><span>At the playhead</span>');
    expect(colourPanel).toContain('aria-label="New adjustment"');
    expect(colourPanel).not.toContain('aria-label="Colour section"');
    expect(colourPanel).not.toContain('Opacity');
    // The track keeps no Colour: its Opacity is part of its Transform, editable on an empty track.
    expect(trackPanel).not.toContain('aria-label="Colour section"');
    expect(trackPanel).not.toContain('Track keyframes');
    expect(trackPanel).toContain('aria-label="Transform section"');
    expect(trackPanel).toContain('aria-label="Fades section"');
    const transform = trackPanel.slice(
      trackPanel.indexOf('aria-label="Transform section"'),
      trackPanel.indexOf('aria-label="Fades section"'),
    );
    const opacity = [...transform.matchAll(/<input[^>]*aria-label="Transform Opacity"[^>]*>/g)].map(
      (match) => match[0],
    );
    expect(opacity).toHaveLength(2);
    expect(opacity[0]).toContain('type="range"');
    expect(opacity[0]).toContain('value="100"');
    expect(opacity[1]).toContain('type="number"');
    expect(opacity[1]).toContain('value="100"');
    expect(opacity[0]).not.toContain('disabled');
    expect(transform).toContain('%');
    expect(transform).toContain('aria-label="Keyframe Opacity"');
    expect(markup).not.toContain('Animate Colour');
    expect(markup).not.toContain('Keyframe Layer opacity');
    expect(markup).not.toContain('Keyframe Clip opacity');

    // An adjustment at the playhead: its stored keyframe list sits inside its Colour section, before HSL ranges.
    project.adjustments = [createAdjustment('look', 0, 100)];
    const adjusted = panelsOf(render(project)).colour;
    expect(adjusted).toContain('aria-label="Colour section"');
    const colourSection = adjusted.slice(
      adjusted.indexOf('aria-label="Colour section"'),
      adjusted.indexOf('aria-label="HSL ranges section"'),
    );
    expect(colourSection).toContain('aria-label="Adjustment keyframes adjustment ');
    expect(adjusted).not.toContain('aria-label="Keyframes section"');
    expect(adjusted).not.toContain('Opacity');
  });

  it.each(KEYFRAME_SETTINGS)('$label shares its setting-specific bounds and accessible controls', (setting) => {
    const name = `${setting.label} keyframe value 200`;
    const markup = renderToStaticMarkup(
      createElement(RangeSettingControl, {
        setting: setting.key,
        id: 'value',
        label: name,
        value: setting.min,
        disabled: false,
        hint: 'Stored point 200',
        exact: { resetKey: 'point' },
        onCommit: vi.fn(),
      }),
    );
    const scale = setting.key === 'opacity' ? 100 : 1;
    expect(markup).toContain(`min="${setting.min * scale}"`);
    expect(markup).toContain(`max="${setting.max * scale}"`);
    expect(markup).toContain(`step="${setting.step * scale}"`);
    expect(markup).toContain(`aria-label="${name}"`);
    expect(markup).toContain('type="number"');
    expect(markup).toMatch(/class="value-control"[^>]*><input[^>]*type="range"[^>]*\/><span class="number-field"/);
    expect(markup).not.toContain('<output');
  });

  it.each(['adjustment', 'clip'] as const)(
    'renders only existing %s keyframe participants, including off-duration points, without adding diamonds or clip-speed modes',
    (noun) => {
      const project = createProject('points', 'Points');
      const key = layerKeyAsGradeKey(layerKeyframe(200, { ...EMPTY_KEY_VALUES, exposure: 0.5 }, 'hold'));
      const clip = createClip('shot', 'source', 0, 100);
      clip.grade.keyframes = [key];
      const owner =
        noun === 'clip'
          ? clipColourOwner(clip, 'Clip 1')
          : adjustmentColourOwner({ ...createAdjustment('look', 0, 50), keyframes: [key] }, 'Adjustment 1');
      const markup = renderToStaticMarkup(
        createElement(
          KeyframeNavigationContext.Provider,
          { value: navigation },
          createElement(ColourKeyframeList, {
            project,
            layer: owner,
            frame: 0,
            duration: 0,
            disabled: false,
            onEdit: vi.fn(),
          }),
        ),
      );
      expect(markup).toContain('Exposure keyframe value 200');
      // Opacity belongs to the track Transform, never to a grade's keyframes.
      expect(markup).not.toContain('Opacity keyframe value');
      expect(markup).not.toContain('Brightness keyframe value');
      expect(markup).not.toContain('aria-label="Keyframe Exposure"');
      expect(markup).not.toContain('Speed mode');
      expect(markup).toContain('Outside duration');
      expect(markup).toContain(`<ol class="keyframe-list keyframe-entries" aria-label="Edit ${noun} keyframes">`);
      expect(markup).not.toContain('Edit points');
      expect(markup).not.toContain('pascap-layer-key-list');
    },
  );
});
