import { describe, expect, it } from 'vitest';
import { requireFirefoxGraphics, type FirefoxGraphicsReadiness } from '../../scripts/ci/firefox-webgl.js';

const ready: FirefoxGraphicsReadiness = {
  contextError: '',
  renderer: 'llvmpipe (LLVM)',
  version: 'WebGL 2.0',
  shaderError: null,
  pixel: [64, 128, 191, 255],
  glError: 0,
  contextLost: false,
};

describe('Firefox graphics prerequisite', () => {
  it('accepts successful real-context evidence', () => {
    expect(() => requireFirefoxGraphics(ready)).not.toThrow();
  });

  it.each([
    { contextError: 'AllowWebgl2:false restricts context creation on this system.', renderer: null, pixel: [] },
    { renderer: null },
    { version: 'WebGL 1.0' },
    { shaderError: 'Compositor shader compilation failed.' },
    { contextLost: true },
    { glError: 1282 },
    { pixel: [0, 0, 0, 255] },
  ])('fails explicitly on missing/broken graphics evidence: %j', (failure) => {
    const result = { ...ready, ...failure };
    expect(() => requireFirefoxGraphics(result)).toThrow('Firefox WebGL2 prerequisite failed.');
    expect(() => requireFirefoxGraphics(result)).toThrow('xvfb-run');
    expect(() => requireFirefoxGraphics(result)).toThrow(JSON.stringify(result));
  });
});
