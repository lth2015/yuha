/**
 * Song sharing: the intranet check and the social intents.
 * The share button once did nothing on the http intranet deployment; these
 * pin down the pieces the new menu relies on.
 */
import { describe, expect, it } from 'vitest';
import { isPrivateHost, shareTargets } from '../apps/web/src/lib/share.js';

describe('isPrivateHost', () => {
  it('flags addresses only the same network can open', () => {
    for (const h of ['10.5.0.7', '192.168.1.20', '172.16.0.1', '172.31.255.1', '127.0.0.1', 'localhost', '[::1]', 'nas.local', 'yuha.internal']) {
      expect(isPrivateHost(h), h).toBe(true);
    }
  });
  it('leaves public names and addresses alone', () => {
    for (const h of ['yuha.app', '8.8.8.8', '172.32.0.1', '172.15.0.1', '11.0.0.1', 'example.com']) {
      expect(isPrivateHost(h), h).toBe(false);
    }
  });
});

describe('shareTargets', () => {
  const url = 'https://yuha.app/song/abc?x=1&y=2';
  const text = '我用 YUHA 做了一首歌：《雨 & 夜》';

  it('encodes the link and text so neither can break out of its parameter', () => {
    for (const target of shareTargets(url, text, 'en')) {
      const parsed = new URL(target.href);
      expect(parsed.protocol).toBe('https:');
      const values = [...parsed.searchParams.values()];
      expect(values).toContain(url);
    }
    const x = new URL(shareTargets(url, text, 'en').find((t) => t.id === 'x')!.href);
    expect(x.searchParams.get('text')).toBe(text);
  });

  it('leads with the network the reader most likely uses', () => {
    expect(shareTargets(url, text, 'ja')[0]!.id).toBe('line');
    expect(shareTargets(url, text, 'zh')[0]!.id).toBe('weibo');
    expect(shareTargets(url, text, 'en')[0]!.id).toBe('x');
    expect(shareTargets(url, text, 'zh')).toHaveLength(4);
  });
});
