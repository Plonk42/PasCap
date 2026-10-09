import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { interpolatedProgress, interpolationSchema } from '../../src/shared/keyframes.js';
import { EasingSelect, easingGraphPoints } from '../../src/web/EasingSelect.js';

describe('easing selection graphs', () => {
  it.each(interpolationSchema.options)('samples the existing %s progress and preserves exact endpoints', (curve) => {
    const points = easingGraphPoints(curve)
      .split(' ')
      .map((point) => point.split(',').map(Number));
    expect(points).toHaveLength(curve === 'hold' ? 34 : 33);
    for (let index = 0; index <= 32; index++) {
      const progress = index / 32;
      expect(points[index]).toEqual([6 + progress * 84, 50 - 44 * interpolatedProgress(progress, curve)]);
    }
    expect(points[0]).toEqual([6, 50]);
    expect(points.at(-1)).toEqual([90, 6]);
    if (curve === 'hold') expect(points.at(-2)).toEqual([90, 50]);
  });

  it('renders distinguishable shapes', () => {
    expect(new Set(interpolationSchema.options.map(easingGraphPoints)).size).toBe(5);
  });

  it('keeps one native select, no extra tab stop, and a described decorative graph', () => {
    const markup = renderToStaticMarkup(
      createElement(EasingSelect, {
        value: 'ease-in',
        onChange: vi.fn(),
        'aria-label': 'Track keyframe easing 10',
        'aria-describedby': 'timing-help',
      }),
    );
    expect(markup.match(/<select/g)).toHaveLength(1);
    expect(markup.match(/<option/g)).toHaveLength(5);
    expect(markup).toContain('aria-label="Track keyframe easing 10"');
    expect(markup).toMatch(/aria-describedby="timing-help [^"]+"/);
    expect(markup).toContain('aria-hidden="true" focusable="false"');
    expect(markup).toContain('Start slowly, then change faster.');
    expect(markup).not.toContain('tabindex');
  });

  it('always offers all five plain-labelled shapes, including Hold, when disabled', () => {
    const markup = renderToStaticMarkup(
      createElement(EasingSelect, {
        value: 'smooth',
        onChange: vi.fn(),
        disabled: true,
      }),
    );
    expect(markup.match(/<option/g)).toHaveLength(5);
    expect(markup).toContain('value="hold"');
    expect(markup).not.toContain('Smooth (S curve)');
    expect(markup).toContain('disabled=""');
  });
});
