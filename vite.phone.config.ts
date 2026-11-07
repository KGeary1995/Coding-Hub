import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The phone app Trace serves to paired phones (electron/services/remote). It is built after the desktop renderer,
// into dist/phone, so it ships inside the app and needs nothing from the desktop bundle at runtime.
export default defineConfig({
  root: 'phone',
  // The chat view is React, shared with the desktop (src/components/chat).
  plugins: [react()],
  base: '/',
  publicDir: 'public',
  // noVNC (the phone's Screen) awaits at the top of a module, which Vite's default target refuses.
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  build: { outDir: '../dist/phone', emptyOutDir: true, assetsInlineLimit: 0, target: 'es2022' },
});
