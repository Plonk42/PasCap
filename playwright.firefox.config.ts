import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

/** Optional Firefox compatibility checks; required Chrome validation is unchanged. */
export default defineConfig(base, {
  use: {
    browserName: 'firefox', channel: undefined,
    launchOptions: {
      args: [],
      firefoxUserPrefs: { 'media.autoplay.default': 0 },
    },
  },
});