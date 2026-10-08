/**
 * Where Google sends the browser back to, and why it is checked at start-up.
 *
 * Google compares the `redirect_uri` on an authorization request against the
 * list registered in the Cloud Console **byte for byte** and answers
 * `redirect_uri_mismatch` on its own page. The request never reaches us, so
 * there is no log line, no failed sign-in to inspect and nothing in any
 * dashboard — the only evidence is the URL in the address bar. A wrong value
 * is therefore not something to discover in production; it is something to
 * refuse at boot, with a message that names the mistake.
 *
 * Two mistakes are easy and both look reasonable:
 *
 *   - registering the SPA's `/auth/google/callback`. That route exists and is
 *     part of the flow — it is where the API sends the browser afterwards with
 *     a one-time code — which is exactly why it reads like the callback.
 *   - keeping a host from the previous deployment. The variable is an absolute
 *     URL because Google needs the origin, so moving environments makes every
 *     copy of it stale. This is the one that bites during an AWS migration.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../apps/api/src/config.js';
import {
  GOOGLE_CALLBACK_PATH,
  GOOGLE_WEB_RETURN_PATH,
  googleRedirectUri,
} from '../apps/api/src/auth/google-paths.js';

const root = resolve(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

const API = 'https://yuha.studio';

const env = (over: Record<string, string | undefined> = {}) => {
  const base: Record<string, string> = {
    RUN_MODE: 'integration',
    DATABASE_URL: 'mysql://u:p@localhost:3306/x',
    STORAGE_SIGNING_SECRET: 'storage-secret',
    AUTH_ADAPTER: 'google',
    PUBLIC_API_URL: API,
    PUBLIC_WEB_URL: API,
    GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'google-client-secret',
    GOOGLE_SESSION_SECRET: 'google-session-secret',
    GOOGLE_REDIRECT_URI: googleRedirectUri(API),
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base as never;
};

const refusal = (over: Record<string, string | undefined>): string => {
  try {
    loadConfig(env(over));
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).message;
  }
  throw new Error('the configuration was accepted');
};

describe('the Google callback is one constant', () => {
  it('is the path the API actually registers', () => {
    // Not a string written twice. The route, the redirect-URI check, the
    // deployment configuration and this test all name the same export, so a
    // change to the route cannot leave the check pointing at the old path.
    expect(read('apps/api/src/routes/auth.ts')).toContain('app.get(GOOGLE_CALLBACK_PATH');
    expect(GOOGLE_CALLBACK_PATH).toBe('/v1/auth/google/callback');
  });

  it('is not the path the web app returns to', () => {
    /*
     * The distinction the whole check exists for. Both are real routes in
     * this product and only one of them is Google's.
     */
    expect(GOOGLE_WEB_RETURN_PATH).not.toBe(GOOGLE_CALLBACK_PATH);
    expect(read('apps/web/src/App.tsx')).toContain(`path="${GOOGLE_WEB_RETURN_PATH}"`);
    expect(read('apps/api/src/auth/google.ts')).toContain('GOOGLE_WEB_RETURN_PATH');
  });

  it('builds the value to register from an origin', () => {
    expect(googleRedirectUri('https://yuha.studio')).toBe('https://yuha.studio/v1/auth/google/callback');
    // A trailing slash on the origin must not produce a doubled one: Google
    // compares byte for byte, so `//v1/...` is a different URI.
    expect(googleRedirectUri('https://yuha.studio/')).toBe('https://yuha.studio/v1/auth/google/callback');
  });
});

describe('a Google redirect URI the deployment cannot be right about', () => {
  it('is accepted when it is the API origin plus the API path', () => {
    expect(() => loadConfig(env())).not.toThrow();
  });

  it('is refused when it is the web app\'s own return path', () => {
    const message = refusal({ GOOGLE_REDIRECT_URI: `${API}${GOOGLE_WEB_RETURN_PATH}` });
    expect(message).toContain(GOOGLE_CALLBACK_PATH);
    // And says why, because the path looks like a callback and is one — just
    // not Google's.
    expect(message).toContain('never be given');
  });

  it('is refused when the host is a deployment behind', () => {
    /*
     * The AWS-migration failure: everything else moves, this does not, and
     * the first symptom is Google refusing on its own page with nothing on
     * our side to look at.
     */
    const message = refusal({ GOOGLE_REDIRECT_URI: googleRedirectUri('https://old.yuha.studio') });
    expect(message).toContain('old.yuha.studio');
    expect(message).toContain(`${API}${GOOGLE_CALLBACK_PATH}`);
  });

  it('is refused when it points at some other path on the right host', () => {
    expect(refusal({ GOOGLE_REDIRECT_URI: `${API}/auth/callback` })).toContain(GOOGLE_CALLBACK_PATH);
    // Including a trailing slash, which Google treats as a different URI.
    expect(refusal({ GOOGLE_REDIRECT_URI: `${API}${GOOGLE_CALLBACK_PATH}/` })).toContain(
      GOOGLE_CALLBACK_PATH,
    );
  });

  it('is refused when it is not a URL at all', () => {
    expect(refusal({ GOOGLE_REDIRECT_URI: '/v1/auth/google/callback' })).toContain('absolute URL');
  });

  it('is refused over plain http in production', () => {
    const message = refusal({
      RUN_MODE: 'production',
      GOOGLE_REDIRECT_URI: googleRedirectUri('http://yuha.studio'),
      PUBLIC_API_URL: 'http://yuha.studio',
    });
    expect(message).toContain('https');
  });

  it('still reports it simply missing', () => {
    expect(refusal({ GOOGLE_REDIRECT_URI: undefined })).toContain('GOOGLE_REDIRECT_URI is required');
  });
});

describe('the deployment configuration names it', () => {
  it('production carries the real value, derived from its own API host', () => {
    /*
     * Not a secret — it is in the authorization URL — so it belongs in the
     * ConfigMap and can be written down rather than left as an empty string
     * for somebody to guess. It is also derivable: the API host is already in
     * the same file.
     */
    const prod = read('deploy/envs/production.yaml');
    const apiUrl = /publicApiUrl:\s*"([^"]+)"/.exec(prod)?.[1];
    expect(apiUrl).toBeTruthy();
    const redirect = /redirectUri:\s*"([^"]+)"/.exec(prod)?.[1];
    expect(redirect).toBe(googleRedirectUri(apiUrl!));
  });

  it('reaches a pod, and the secret half does not go near the ConfigMap', () => {
    const configmap = read('infra/helm/loopscene/templates/configmap.yaml');
    expect(configmap).toContain('GOOGLE_REDIRECT_URI:');
    expect(configmap).toContain('GOOGLE_CLIENT_ID:');
    // The client secret and the state-signing secret are secrets and live in
    // the External Secrets mapping instead.
    expect(configmap).not.toContain('GOOGLE_CLIENT_SECRET');
    expect(configmap).not.toContain('GOOGLE_SESSION_SECRET');
    const secrets = read('deploy/cluster/external-secrets.yaml');
    expect(secrets).toContain('GOOGLE_CLIENT_SECRET');
    expect(secrets).toContain('GOOGLE_SESSION_SECRET');
  });

  it('is in .env.example, which is what preflight checks for', () => {
    /*
     * The whole block was absent while `scripts/preflight.mjs` reported on
     * these three keys — so the thing that exists to say what is missing was
     * looking for keys the documented `cp .env.example .env` could not
     * produce.
     */
    const example = read('.env.example');
    for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GOOGLE_SESSION_SECRET']) {
      expect(example, `${key} is missing from .env.example`).toMatch(new RegExp(`^${key}=`, 'm'));
    }
    expect(read('scripts/preflight.mjs')).toContain('GOOGLE_REDIRECT_URI');
  });
});
