import { defineConfig } from 'vite';

// The phone app Trace serves to paired phones (electron/services/remote). It is built after the desktop renderer,
// into dist/phone, so it ships inside the app and needs nothing from the desktop bundle at runtime.
export default defineConfig({
  root: 'phone',
  base: '/',
  publicDir: 'public',
  build: { outDir: '../dist/phone', emptyOutDir: true, assetsInlineLimit: 0 },
});
