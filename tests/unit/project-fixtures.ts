import { NEUTRAL_COLOUR } from '../../src/shared/colour.js';
import { EMPTY_KEY_VALUES } from '../../src/shared/keyframes.js';
import { BASE_LAYER_ID } from '../../src/shared/model.js';
import { PROJECT_FPS } from '../../src/shared/timing.js';

/** An actual schema-3 input, not a current document with its version relabelled. */
export function legacyV3Project(id: string, title: string) {
  return {
    schemaVersion: 3, id, title, frameRate: { ...PROJECT_FPS }, colourProfile: 'bt709-sdr',
    layers: [{
      id: BASE_LAYER_ID, name: 'Video 1', enabled: true, opacity: 1,
      opacityKeys: [{ frame: 0, value: 1, interpolation: 'linear' }, { frame: 60, value: 0.5, interpolation: 'hold' }],
    }],
    clips: [{
      id: 'legacy-clip', mediaId: 'legacy-media', layerId: BASE_LAYER_ID, start: 0, sourceIn: 0, sourceOut: 60,
      colour: { ...NEUTRAL_COLOUR }, opacity: 1,
      speed: { mode: 'keyframes', keys: [{ frame: 0, value: 1, interpolation: 'linear' }, { frame: 59, value: 2, interpolation: 'hold' }] },
      animation: {
        opacity: [{ frame: 0, value: 1, interpolation: 'linear' }, { frame: 59, value: 0.5, interpolation: 'hold' }],
        colour: [{ frame: 0, value: { ...NEUTRAL_COLOUR, exposure: 0.5 }, interpolation: 'hold' }],
      },
    }],
    transitions: [], openingFade: 0, closingFade: 0, music: null, revision: 0,
  };
}

/** A genuine schema-4 input: shared row points/static clip bases, but no project media bin. */
export function legacyV4Project(id: string, title: string) {
  return {
    schemaVersion: 4, id, title, frameRate: { ...PROJECT_FPS }, colourProfile: 'bt709-sdr',
    layers: [{
      id: BASE_LAYER_ID, name: 'Video 1', enabled: true, opacity: 1,
      keyframes: [{ frame: 0, interpolation: 'linear', values: { ...EMPTY_KEY_VALUES, exposure: 0.5 } }],
    }],
    clips: [{
      id: 'legacy-clip', mediaId: 'legacy-media', layerId: BASE_LAYER_ID, start: 0, sourceIn: 0, sourceOut: 60,
      colour: { ...NEUTRAL_COLOUR }, opacity: 1, speed: { mode: 'constant', rate: 1 },
    }],
    transitions: [], openingFade: 0, closingFade: 0, music: null, revision: 0,
  };
}

/** Genuine schema 5: project bins and row points, but global transitions/fades. */
export function legacyV5Project(id: string, title: string) {
  return {
    ...legacyV4Project(id, title), schemaVersion: 5,
    media: { videoIds: ['legacy-media'], audioIds: [] },
  };
}