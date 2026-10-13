import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The packaged app loads dist/index.html over file://, where response-header CSP from
// electron/main.ts never applies. Keep this in sync with the production policy there.
const PRODUCTION_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'self'; base-uri 'self'";

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
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: { manualChunks: { terminal: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl'] } },
    },
  },
});
