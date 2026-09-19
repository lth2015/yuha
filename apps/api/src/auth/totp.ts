import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

/**
 * TOTP second factor, RFC 6238 / RFC 4226 — the protocol Google Authenticator
 * (and every authenticator app) speaks. Google's own product surface for
 * consumer accounts exposes no MFA API we could call on a user's behalf, so
 * this is the standard commercial integration: our server issues an
 * `otpauth://` enrollment URI, the user adds it to Google Authenticator from
 * a QR code, and logins present a 6-digit code we verify here.
 *
 * Secrets are stored AES-256-GCM encrypted; recovery codes are stored only
 * as SHA-256 hashes and are single-use.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding — what authenticator apps expect. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, base32-encoded (32 characters — no padding bits). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The enrollment URI encoded into the QR code. */
export function otpauthUri(params: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac('sha1', secret).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const code =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}

export function totpNow(secretBase32: string, atMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), Math.floor(atMs / 30_000));
}

/**
 * Verifies a 6-digit code against the secret with a ±1 step window (drift
 * tolerance), in constant time on the comparison itself.
 */
export function verifyTotp(secretBase32: string, code: string, atMs = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(secretBase32);
  const step = Math.floor(atMs / 30_000);
  for (const drift of [-1, 0, 1]) {
    if (hotp(secret, step + drift) === code) return true;
  }
  return false;
}

// ------------------------------------------------------------- recovery codes

/** 8 single-use recovery codes, shown once: xxxx-xxxx. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: 8 }, () => {
    const a = randomInt(0, 0xffff).toString(16).padStart(4, '0');
    const b = randomInt(0, 0xffff).toString(16).padStart(4, '0');
    return `${a}-${b}`;
  });
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}

// ------------------------------------------------------- secret encryption

/**
 * AES-256-GCM at rest. Key material comes from the dedicated MFA secret (or
 * the session secret outside production, never a hard-coded default).
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash('sha256').update(`mfa:${secret}`).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
  }

  decrypt(payload: string): string {
    const [ivB, tagB, dataB] = payload.split('.');
    if (!ivB || !tagB || !dataB) throw new Error('malformed encrypted secret');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64url')), decipher.final()]).toString('utf8');
  }
}
