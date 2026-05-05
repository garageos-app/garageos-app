import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite reads VITE_* env vars from the process at build time and exposes them
// via import.meta.env. Build is triggered by deploy-web.yml with vars.VITE_*
// passed in the env block (see .github/workflows/deploy-web.yml).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
