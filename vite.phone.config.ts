import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

// The phone app Trace serves to paired phones (electron/services/remote). It is built after the desktop renderer,
// into dist/phone, so it ships inside the app and needs nothing from the desktop bundle at runtime.
export default defineConfig({
  root: 'phone',
  // The chat view is React, shared with the desktop (src/components/chat).
  plugins: [react()],
  base: '/',
  // The version the app is built with: the phone compares it with its computer's and reloads itself after an update.
  define: { __TRACE_VERSION__: JSON.stringify(process.env.npm_package_version ?? (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version) },
  publicDir: 'public',
  // noVNC (the phone's Screen) awaits at the top of a module, which Vite's default target refuses.
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  build: { outDir: '../dist/phone', emptyOutDir: true, assetsInlineLimit: 0, target: 'es2022' },
});
