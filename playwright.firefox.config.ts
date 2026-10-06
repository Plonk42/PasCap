import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

/** Required scoped Firefox regressions; full Chrome validation is unchanged. */
export default defineConfig(base, {
    globalSetup: ['./scripts/ci/firefox-webgl.ts', './scripts/ci/firefox-audio.ts'],
    use: {
        browserName: 'firefox', channel: undefined,
        launchOptions: {
            args: [],
            firefoxUserPrefs: {
                'media.autoplay.default': 0,
                // Report the actual backend, not Firefox's generic renderer alias.
                'webgl.sanitize-unmasked-renderer': false,
            },
        },
    },
});