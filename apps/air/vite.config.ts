import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * A standalone static app: no API proxy, no env, nothing shared with apps/web.
 *
 * `pnpm --filter @yuha/air phone` serves it on the local network over HTTPS
 * with a self-signed certificate, so an iPhone on the same Wi-Fi can open it.
 * HTTPS matters for #27: a page on plain http is not a secure context, and an
 * API that is only exposed to secure contexts would then look absent — a
 * false "this fix does not work". The probe prints `isSecureContext` on every
 * row so such a run cannot pass for a real one.
 */
const page = process.env['AIR_PAGE'];

export default defineConfig(({ mode }) => ({
  // Relative asset URLs: the build can be served from any path.
  base: './',
  plugins: mode === 'phone' ? [basicSsl()] : [],
  server: { port: 5180, strictPort: true },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // index.html is the instrument; probe.html is the #27 first-sound probe.
    // AIR_PAGE builds one page alone (build-artifact.mjs), so nothing is split into a shared chunk.
    rollupOptions: { input: page ? { [page]: `${page}.html` } : { index: 'index.html', probe: 'probe.html' } },
  },
}));
