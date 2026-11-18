/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { configDefaults } from 'vitest/config';

// The packaged app loads dist/index.html over file://, where response-header CSP from
// electron/main.ts never applies. Keep this in sync with the production policy there.
const PRODUCTION_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'self'; base-uri 'self'";

function productionCsp(): Plugin {
  return {
    name: 'coding-hub-production-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: PRODUCTION_CSP }, injectTo: 'head-prepend' }],
  };
}

export default defineConfig({
  plugins: [react(), productionCsp()],
  base: './',
  // CODING_HUB_NO_HMR=1: a page keeps the modules it loaded, so scripts/design-tour.cjs --dev is not reloaded by an edit.
  server: { host: '127.0.0.1', port: 5173, strictPort: true, hmr: process.env.CODING_HUB_NO_HMR === '1' ? false : undefined },
  // Built apps under release/ hold copies of the compiled tests; only the sources are tested.
  test: { setupFiles: ['./vitest.setup.ts'], exclude: [...configDefaults.exclude, 'release/**'] },
  // noVNC (the linked-screen viewer) awaits at the top of a module; Electron's Chromium runs that, Vite's default target refuses it.
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: {
      output: { manualChunks: { terminal: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl'] } },
    },
  },
});
