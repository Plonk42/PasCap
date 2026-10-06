import { defineConfig } from '@playwright/test';
import path from 'node:path';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: 'http://127.0.0.1:4320',
    viewport: { width: 1440, height: 900 },
    browserName: 'chromium',
    channel: 'chrome',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `PASCAP_PORT=4320 PASCAP_DATA_DIR=.pascap/browser-tests PASCAP_MEDIA_ROOTS='${JSON.stringify([path.resolve('.pascap/browser-footage/synthetic-sources')])}' node dist/server/server/main.js`,
    url: 'http://127.0.0.1:4320/api/health',
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
