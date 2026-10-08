import base from './playwright.config.js';

/**
 * Hosted-runner conditions for reproducing CI-only failures locally: software
 * WebGL with no GPU process. Run through `npm run test:browser:ci-like`, which
 * also pins the whole test run to two CPU cores.
 */
export default {
  ...base,
  use: {
    ...base.use,
    launchOptions: {
      args: [
        ...(base.use?.launchOptions?.args ?? []),
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-gpu',
      ],
    },
  },
};
