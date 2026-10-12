import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

const root = __dirname;

export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  resolve: {
    // Only the pure type/helper package is importable from the renderer.
    alias: {
      '@aegis/core': path.resolve(root, '../../../packages/core/src/index.ts'),
      '@aegis/codegen': path.resolve(root, '../../../packages/codegen/src/index.ts'),
    },
  },
  build: {
    outDir: path.resolve(root, '../../../dist/renderer'),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 6000,
  },
  worker: { format: 'es' },
  server: { host: 'localhost', port: 5173, strictPort: true },
});
