import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

it('the iOS scaffold cannot create a checkout or send a stored Web token', async () => {
  vi.stubEnv('VITE_APP_PLATFORM', 'ios');
  vi.stubGlobal('localStorage', { getItem: () => 'old-web-token' });
  const fetch = vi.fn().mockResolvedValue(new Response('{"mode":"production"}'));
  vi.stubGlobal('fetch', fetch);
  const { apiFetch, getToken } = await import('../apps/web/src/lib/api');
  await expect(apiFetch('/v1/checkout', { method: 'POST', body: { priceKey: 'topup' } })).rejects.toThrow('iOS preview');
  expect(fetch).not.toHaveBeenCalled();
  expect(getToken()).toBeNull();
  await apiFetch('/v1/runtime');
  expect(fetch.mock.calls[0]?.[1].headers).not.toHaveProperty('authorization');
});

it('the iOS build command rejects missing development origins before building', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['scripts/ios.mjs', 'build', '--environment', 'development'], {
    env: { ...process.env, IOS_API_URL: '' }, encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('IOS_API_URL must be an HTTPS origin');
});

it.each([
  ['development', 'http://localhost:4000'],
  ['staging', 'https://user:password@example.test'],
  ['staging', 'https://staging.example.invalid/v1'],
  ['staging', 'https://staging.example.invalid?token=private'],
  ['staging', 'https://staging.example.invalid#secret'],
  ['staging', 'https://yuha.studio'],
  ['production', 'https://other.example.invalid'],
])('rejects an unsafe or mislabeled %s API origin without exposing its value', async (environment, origin) => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['scripts/ios.mjs', 'config', '--environment', environment], {
    env: { ...process.env, IOS_API_URL: origin }, encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain(origin);
});

it.each([
  ['development', 'https://dev.example.invalid'],
  ['staging', 'https://staging.example.invalid'],
  ['production', 'https://yuha.studio'],
])('selects a public HTTPS origin for %s without building or touching a server', async (environment, origin) => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['scripts/ios.mjs', 'config', '--environment', environment], {
    env: { ...process.env, IOS_API_URL: origin }, encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ apiOrigin: origin, environment });
});

it.each(['/v1/checkout', '/v1/auth/google/start', '/v1/me', '/v1/admin/users'])('blocks native preview access to %s even with GET', async (path) => {
  vi.stubEnv('VITE_APP_PLATFORM', 'ios');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const { apiFetchText, setToken } = await import('../apps/web/src/lib/api');
  await expect(apiFetchText(path)).rejects.toThrow('iOS preview');
  expect(() => setToken('new-token')).toThrow('iOS preview');
  expect(fetch).not.toHaveBeenCalled();
});

it('the native legal disclosure can read the public catalogue without enabling checkout', async () => {
  vi.stubEnv('VITE_APP_PLATFORM', 'ios');
  const fetch = vi.fn().mockResolvedValue(new Response('{"items":[]}'));
  vi.stubGlobal('fetch', fetch);
  const { apiFetch } = await import('../apps/web/src/lib/api');
  await expect(apiFetch('/v1/products')).resolves.toEqual({ items: [] });
  await expect(apiFetch('/v1/checkout', { method: 'POST' })).rejects.toThrow('iOS preview');
  expect(fetch).toHaveBeenCalledTimes(1);
});
