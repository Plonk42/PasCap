import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_KEY_VALUES, KEYFRAME_SETTINGS } from '../../src/shared/keyframes.js';
import { createProject } from '../../src/shared/model.js';
import { Inspector } from '../../src/web/Inspector.js';
import { KeyframeNavigationContext } from '../../src/web/keyframe-navigation.js';
import { KeyframeControls } from '../../src/web/KeyframeControls.js';
import { RangeSettingControl, SpeedRateField } from '../../src/web/SettingValueControl.js';

const navigation = {
  inspection: null,
  duration: 0,
  disabled: false,
  onSeekKeyframe: vi.fn(),
  onFollowPlayhead: vi.fn(),
};

describe('dedicated Inspector keyframe controls', () => {
  it('labels four mounted tab panels and keeps empty-row points in their own panel', () => {
    const project = createProject('tabs', 'Tabs');
    const markup = renderToStaticMarkup(
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
          section: 'keyframes',
          onSection: vi.fn(),
          onEdit: vi.fn(),
          onPreview: vi.fn(),
          onSeek: vi.fn(),
          onPause: vi.fn(),
        }),
      ),
    );
    const tabs = [...markup.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/g)].map((match) => match[1]);
    expect(tabs).toEqual(['Clip', 'Keyframes', 'Sequence', 'Audio']);
    expect(markup).toContain('aria-label="Layer keyframes"');
    expect(markup).not.toContain('inspector-track-selection');
    expect(markup).not.toContain('Whole-row animation');
    expect(markup).not.toContain('Track transitions &amp; fades');
    const panels = [...markup.matchAll(/<div role="tabpanel"[^>]*>/g)].map((match) => match[0]);
    expect(panels).toHaveLength(4);
    expect(panels[1]).not.toContain('hidden');
    expect(panels.filter((panel) => panel.includes('hidden'))).toHaveLength(3);
    const clipPanel = markup.slice(markup.indexOf(panels[0]!), markup.indexOf(panels[1]!));
    const keysPanel = markup.slice(markup.indexOf(panels[1]!), markup.indexOf(panels[2]!));
    expect(clipPanel).not.toContain('aria-label="Layer keyframes Video 1"');
    expect(keysPanel).toContain('aria-label="Layer keyframes Video 1"');
    expect(clipPanel).toContain('aria-label="Placement section"');
    expect(clipPanel).not.toContain('Layer &amp; opacity');
    const opacity = [...clipPanel.matchAll(/<input[^>]*aria-label="Opacity"[^>]*>/g)].map((match) => match[0]);
    expect(opacity).toHaveLength(2);
    expect(opacity[0]).toContain('type="range"');
    expect(opacity[0]).toContain('value="1"');
    expect(opacity[1]).toContain('type="number"');
    expect(opacity[1]).toContain('value="1"');
    expect(opacity[0]).not.toContain('disabled');
    expect(clipPanel).toContain('100%');
    expect(clipPanel).toContain('Not animated');
    const colour = clipPanel.slice(clipPanel.indexOf('aria-label="Colour section"'));
    expect(colour).toContain('aria-label="Opacity"');
    expect(clipPanel.split('aria-label="Keyframe Opacity"')).toHaveLength(2);
    expect(clipPanel).not.toContain('Keyframe Layer opacity');
    expect(clipPanel).not.toContain('Keyframe Clip opacity');
  });

  it.each(KEYFRAME_SETTINGS)('$label shares its setting-specific bounds and accessible controls', (setting) => {
    const name = `${setting.label} keyframe value 200`;
    const markup =
      setting.key === 'speed'
        ? renderToStaticMarkup(
            createElement(SpeedRateField, {
              id: 'rate',
              value: 1,
              disabled: false,
              'aria-label': name,
              onCommit: vi.fn(),
            }),
          )
        : renderToStaticMarkup(
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
    expect(markup).toContain(`min="${setting.min}"`);
    expect(markup).toContain(`max="${setting.max}"`);
    expect(markup).toContain(`step="${setting.step}"`);
    expect(markup).toContain(`aria-label="${name}"`);
    expect(markup).toContain('type="number"');
    expect(markup).toMatch(/class="value-control"[^>]*><input[^>]*type="range"[^>]*\/><span class="number-field"/);
    expect(markup).not.toContain('<output');
  });

  it('renders only existing participants, including off-duration points, without adding diamonds or clip-speed modes', () => {
    const project = createProject('points', 'Points');
    project.layers[0]!.keyframes = [
      { frame: 200, interpolation: 'hold', values: { ...EMPTY_KEY_VALUES, exposure: 0.5, speed: 2 } },
    ];
    const markup = renderToStaticMarkup(
      createElement(
        KeyframeNavigationContext.Provider,
        { value: navigation },
        createElement(KeyframeControls, {
          project,
          layer: project.layers[0]!,
          frame: 0,
          duration: 0,
          disabled: false,
          onEdit: vi.fn(),
        }),
      ),
    );
    expect(markup).toContain('Exposure keyframe value 200');
    expect(markup).toContain('Speed keyframe value 200');
    expect(markup).not.toContain('Brightness keyframe value');
    expect(markup).not.toContain('aria-label="Keyframe Exposure"');
    expect(markup).not.toContain('Speed mode');
    expect(markup).toContain('Outside duration');
    expect(markup).toContain('<ol class="keyframe-list keyframe-entries" aria-label="Edit layer keys">');
    expect(markup).not.toContain('Edit points');
    expect(markup).not.toContain('pascap-layer-key-list');
  });
});
