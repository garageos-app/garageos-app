import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite reads VITE_* env vars from the process at build time and exposes them
// via import.meta.env. Build is triggered by deploy-web.yml with vars.VITE_*
// passed in the env block (see .github/workflows/deploy-web.yml).
export default defineConfig({
  // amazon-cognito-identity-js (transitive `buffer` dep) references Node's
  // `global` at module init. Browsers don't define it, so map it to globalThis.
  define: {
    global: 'globalThis',
  },
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
