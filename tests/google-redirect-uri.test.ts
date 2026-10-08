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
    /*
     * A trailing slash, and a base that carries a path, both resolve to the
     * same absolute callback. (`new URL` guarantees the first of those on its
     * own, so that assertion is about the Node API rather than about this
     * code; the second is not — a `PUBLIC_API_URL` of `https://host/api`
     * would be a plausible deployment and must not produce
     * `/api/v1/auth/...`, because the route is registered at the root.)
     */
    expect(googleRedirectUri('https://yuha.studio/')).toBe('https://yuha.studio/v1/auth/google/callback');
    expect(googleRedirectUri('https://yuha.studio/api')).toBe('https://yuha.studio/v1/auth/google/callback');
  });
});

describe('a Google redirect URI the deployment cannot be right about', () => {
  it('is accepted when it is the API origin plus the API path', () => {
    expect(() => loadConfig(env())).not.toThrow();
  });

  it('is checked whatever AUTH_ADAPTER says, because the flow is registered on credentials', () => {
    /*
     * `routes/auth.ts` registers `/v1/auth/google/*` whenever the three
     * credentials are present — deliberately, "so Sign in with Google can
     * coexist with the dev login in integration mode" — and every check here
     * used to live inside `adapters.auth === 'google'`. So the configuration
     * `.env.example` itself ships, `AUTH_ADAPTER=dev` with the Google values
     * filled, had a live OAuth endpoint and no validation of any of it: the
     * guarantee was absent in the most common way to run the flow.
     */
    for (const adapter of ['dev', 'cognito'] as const) {
      const extra =
        adapter === 'cognito'
          ? { COGNITO_REGION: 'ap-northeast-1', COGNITO_USER_POOL_ID: 'p', COGNITO_APP_CLIENT_ID: 'c' }
          : { DEV_AUTH_SECRET: 'dev-secret' };
      const message = refusal({
        AUTH_ADAPTER: adapter,
        ...extra,
        GOOGLE_REDIRECT_URI: googleRedirectUri('https://stale.example'),
      });
      expect(message, `${adapter} must still check the redirect URI`).toContain('stale.example');
    }
  });

  it('is refused with a query string or a fragment', () => {
    // Google compares the whole URI, so `?env=prod` is a different one — and
    // it passed every other check here before failing, logless, at Google.
    expect(refusal({ GOOGLE_REDIRECT_URI: `${API}${GOOGLE_CALLBACK_PATH}?env=prod` })).toContain(
      'no query string',
    );
    expect(refusal({ GOOGLE_REDIRECT_URI: `${API}${GOOGLE_CALLBACK_PATH}#x` })).toContain('fragment');
  });

  it('requires a state signing secret in production whatever the adapter', () => {
    /*
     * `stateSecret()` was `GOOGLE_SESSION_SECRET ?? DEV_AUTH_SECRET ?? ''`,
     * production forbids `DEV_AUTH_SECRET`, and the secret's check was inside
     * the google-adapter branch — so a production deployment on another
     * adapter with the Google flow configured would have signed the OAuth
     * `state` with the empty string. Forgeable.
     */
    const message = refusal({
      RUN_MODE: 'production',
      AUTH_ADAPTER: 'cognito',
      COGNITO_REGION: 'ap-northeast-1',
      COGNITO_USER_POOL_ID: 'p',
      COGNITO_APP_CLIENT_ID: 'c',
      GOOGLE_SESSION_SECRET: undefined,
    });
    expect(message).toContain('GOOGLE_SESSION_SECRET');
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
  it.each(['production', 'staging', 'qa'])(
    '%s derives its redirect URI from its own API host, or declares neither',
    (env) => {
      /*
       * Every environment, not only production — and the YAML is read with
       * optional quotes, because `redirectUri: https://…` is idiomatic and the
       * quote-only pattern reported `undefined` for it.
       *
       * The three files are allowed to be empty, but not inconsistent: an
       * environment whose `authAdapter` is google and whose `redirectUri` is
       * blank refuses to boot, which is a thing to find here rather than in a
       * rollout. Staging and qa have no host yet, so what is asserted is the
       * pair: either both are set and agree, or the redirect is blank and the
       * file says so.
       */
      const file = read(`deploy/envs/${env}.yaml`);
      const value = (key: string) => new RegExp(`${key}:\\s*"?([^"\\s#]*)"?`).exec(file)?.[1] ?? '';
      const apiUrl = value('publicApiUrl');
      const redirect = value('redirectUri');

      if (!redirect) {
        // Then the API host is not known either, or the pair is inconsistent.
        expect(apiUrl, `${env} knows its API host but leaves redirectUri blank`).toBe('');
        return;
      }
      expect(apiUrl, `${env} sets redirectUri but not publicApiUrl`).toBeTruthy();
      expect(redirect).toBe(googleRedirectUri(apiUrl));
    },
  );

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
