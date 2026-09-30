import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/client',
  publicDir: false,
  // relative asset URLs so the build also works from a static host / sub-path
  base: './',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  worker: { format: 'es' },
  server: {
    port: 5173,
    proxy: { '/ws': { target: 'ws://localhost:8080', ws: true } },
  },
});
