/**
 * Replace the origin of a provider-supplied audio URL.
 *
 * A self-hosted service builds its audio links from its own `AUDIO_BASE_URL`,
 * which is its LAN address. That is right on that network and unreachable from
 * anywhere else — the first real generation from outside the office failed with
 * `host 10.5.0.7 is not in the provider allow-list` after the model had already
 * run. The same signed path answers on the box's public address, because the
 * signature covers the path and expiry rather than the host.
 *
 * The rule names both origins: `http://lan-host:8583=>http://public-host:8583`.
 * Inferring the replacement — "if the host is private, use `baseUrl`" — would
 * guess, and would redirect a provider that legitimately serves audio from a
 * second host to the wrong place. Anything that does not match the left-hand
 * side is returned untouched, and the host allow-list still runs afterwards, so
 * this cannot introduce a host the operator never named.
 */
export function rewriteAudioOrigin(url: string, rule: string | undefined): string {
  if (!rule) return url;
  const [from, to] = rule.split('=>').map((s) => s.trim());
  if (!from || !to) return url;
  try {
    const target = new URL(url);
    const want = new URL(from);
    const replacement = new URL(to);
    if (target.origin !== want.origin) return url;
    target.protocol = replacement.protocol;
    target.host = replacement.host;
    return target.toString();
  } catch {
    // A url or rule we cannot parse is not ours to fail on: hand it back and
    // let the guarded fetcher report what is actually wrong with it.
    return url;
  }
}
