import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The export GPU compositor page script: one self-contained module the service serves to its own
// headless browser, next to (not inside) the editor build.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  logLevel: 'warn',
  publicDir: false,
  build: {
    outDir: 'dist/gpu-worker',
    emptyOutDir: true,
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL('src/gpu-worker/main.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'gpu-worker.js',
    },
  },
});
