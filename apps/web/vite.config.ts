import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Where `/v1` goes in development.
 *
 * Overridable so someone running the API on another port, or in a container,
 * does not have to edit this file.
 */
const API_TARGET = process.env['VITE_DEV_API_PROXY'] ?? 'http://localhost:4000';

export default defineConfig(({ command, mode }) => {
  /*
   * `VITE_API_URL` unset means the client calls `/v1` on its own origin
   * (see `src/lib/api.ts`). In development that is the proxy below. In a
   * deployed build it is only correct if something in front of the bundle
   * routes `/v1` to the API — and today's CloudFront distribution has one
   * origin, the S3 bucket, and one behaviour, so it would answer `/v1` with
   * `index.html` and the app would fail on HTML where it expected JSON.
   *
   * Warn rather than fail: a same-origin deployment is a legitimate setup, and
   * this file cannot see the CDN in front of it. But an unset value is much
   * more likely to be an oversight, and a warning at build time is cheaper to
   * read than that failure is to diagnose.
   */
  if (command === 'build') {
    // The config file's own directory, not `process.cwd()`: Vite's env files
    // sit next to this file, and the cwd depends on where the build was run
    // from.
    const env = loadEnv(mode, import.meta.dirname, '');
    if (!env['VITE_API_URL']) {
      console.warn(
        '\n  warning: VITE_API_URL is not set. The bundle will call /v1 on its own origin,\n' +
          '  which only works if the CDN or reverse proxy in front of it forwards /v1 to the API.\n',
      );
    }
  }

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      /*
       * The API on the same origin as the page.
       *
       * The client used to call `http://localhost:4000` directly. That is a
       * second origin: it needs CORS to agree on every request, it needs its
       * own approval in any browser that gates localhost access, and the
       * literal `localhost:4000` was the fallback in the shipped bundle
       * whenever a build ran without `VITE_API_URL`. Same-origin removes all
       * three.
       *
       * Only `/v1` is proxied. The API also serves `/health` and `/ready`,
       * which are for the cluster's probes and not for this app, and the web
       * app has no route of its own under `/v1`, so nothing collides.
       */
      proxy: {
        '/v1': {
          target: API_TARGET,
          changeOrigin: false,
          /*
           * Say which side failed.
           *
           * Without this, a proxy that cannot reach the API answers the browser
           * with an empty 500 and `text/plain`. `apiFetch` finds no error
           * envelope in it, falls back to `INTERNAL_ERROR`, and the page says
           * the server had a problem — when in fact there is no server:
           * nothing is listening on the target because `pnpm dev:api` was never
           * started, or it exited. The two look identical on screen, which cost
           * time exactly once.
           *
           * So: 502 (the upstream is at fault, not this dev server), a body
           * that names the target and the OS error, and one line in the
           * terminal where whoever started the dev server is looking.
           */
          configure(proxy) {
            proxy.on('error', (err, _req, res) => {
              const reason = (err as NodeJS.ErrnoException).code ?? err.message;
              const detail = `dev proxy: cannot reach the API at ${API_TARGET} (${reason}). Is \`pnpm dev:api\` running?`;
              console.error(`\n  ${detail}\n`);
              if ('writeHead' in res && !res.headersSent) {
                res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
                res.end(detail);
              } else {
                res.destroy();
              }
            });
          },
        },
      },
    },
    build: {
      // Static output served from S3/CloudFront (§4.2).
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
