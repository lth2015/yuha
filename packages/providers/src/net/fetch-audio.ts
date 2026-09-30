import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Guarded fetcher for provider-supplied audio URLs (SEC-05).
 *
 * Constraints, all enforced before a byte is read:
 *   - HTTPS only;
 *   - host must be on the provider's configured allow-list — we never fetch an
 *     address that came from a user, and there is no reference-music upload;
 *   - every resolved IP must be public, which blocks the metadata service and
 *     private ranges even if DNS is manipulated;
 *   - redirects are refused outright, so an allow-listed host cannot bounce us
 *     somewhere else;
 *   - hard byte cap and wall-clock timeout.
 *
 * `allowInsecureSelfHosted` relaxes the first and third of those, and nothing
 * else, for the case of a model server we run ourselves on the same network —
 * a GPU box on a desk, reachable only as `http://192.168.x.x:8000`, which the
 * https rule and the private-address rule both refuse. The allow-list is what
 * still does the work: the operator has to name that host, so this does not
 * open the fetcher to arbitrary addresses, only to the ones already named.
 *
 * What it costs, stated rather than glossed: with it on, an allow-listed
 * *public* hostname whose DNS has been poisoned to a private address would
 * also be fetched, because the check is off for every allow-listed host and
 * not only for the self-hosted one. That is why `loadConfig` refuses the flag
 * outright in production mode, the same way it refuses the dev auth adapter
 * and the demo music provider — this is a development affordance and is not
 * permitted to reach a deployed environment.
 */
export class UnsafeUrlError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
    this.reason = reason;
  }
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((n) => Number.parseInt(n, 10));
  const [a = 0, b = 0] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('fe80')) return true; // link-local
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique local
  if (v.startsWith('::ffff:')) return isPrivateIpv4(v.slice(7));
  return false;
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !isPrivateIpv4(ip);
  if (family === 6) return !isPrivateIpv6(ip);
  return false;
}

export interface FetchAudioOptions {
  allowedHosts: string[];
  maxBytes: number;
  timeoutMs: number;
  allowedContentTypes?: string[];
  /**
   * Permit plain http and private addresses for allow-listed hosts.
   *
   * Off unless an operator sets it, and refused in production by `loadConfig`.
   * See the note at the top of this file for exactly what it gives up.
   */
  allowInsecureSelfHosted?: boolean;
}

export async function assertSafeUrl(rawUrl: string, opts: FetchAudioOptions): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('malformed_url', 'audio url is not a valid URL');
  }
  const selfHosted = opts.allowInsecureSelfHosted === true;
  if (url.protocol !== 'https:' && !(selfHosted && url.protocol === 'http:')) {
    throw new UnsafeUrlError(
      'not_https',
      selfHosted
        ? 'audio url must use http or https'
        : 'audio url must use https',
    );
  }
  const host = url.hostname.toLowerCase();
  const allowed = opts.allowedHosts.some((h) => {
    const pattern = h.toLowerCase();
    return pattern.startsWith('.') ? host.endsWith(pattern) : host === pattern;
  });
  if (!allowed) {
    throw new UnsafeUrlError('host_not_allowed', `host ${host} is not in the provider allow-list`);
  }

  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length) {
    throw new UnsafeUrlError('dns_failure', `could not resolve ${host}`);
  }
  if (!selfHosted) {
    for (const a of addresses) {
      if (!isPublicAddress(a.address)) {
        throw new UnsafeUrlError('private_address', `${host} resolves to a non-public address`);
      }
    }
  }
  return url;
}

export async function fetchAudio(rawUrl: string, opts: FetchAudioOptions): Promise<Buffer> {
  const url = await assertSafeUrl(rawUrl, opts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept: 'audio/*' },
    });
    if (!res.ok) {
      throw new UnsafeUrlError('upstream_status', `audio fetch returned ${res.status}`);
    }

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const allowedTypes = opts.allowedContentTypes ?? [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/x-wav',
      'audio/wave',
      'application/octet-stream',
    ];
    if (contentType && !allowedTypes.includes(contentType)) {
      throw new UnsafeUrlError('content_type', `unexpected content-type ${contentType}`);
    }

    const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      throw new UnsafeUrlError('too_large', `declared size ${declared} exceeds the limit`);
    }

    // Stream with a running cap, so a lying content-length cannot exhaust memory.
    const reader = res.body?.getReader();
    if (!reader) throw new UnsafeUrlError('empty_body', 'audio response had no body');
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel();
        throw new UnsafeUrlError('too_large', 'audio exceeded the size limit while streaming');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}
