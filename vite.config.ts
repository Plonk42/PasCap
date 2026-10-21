import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    allowedHosts: ['localhost', '127.0.0.1'],
    // OAuth discovery must reach the service's 404s, not the editor page.
    proxy: Object.fromEntries(['/api', '/mcp', '/.well-known'].map((path) => [path, 'http://127.0.0.1:4318'])),
  },
  build: { outDir: 'dist/web', sourcemap: true },
});
