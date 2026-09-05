import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * In development Vite serves the UI on 5317 and proxies everything the
 * server owns. That way the browser only ever talks to one origin.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5317,
    proxy: {
      '/api': 'http://127.0.0.1:4317',
      '/ws': { target: 'ws://127.0.0.1:4317', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
