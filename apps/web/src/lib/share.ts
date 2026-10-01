/**
 * Sharing a song: where it can go, and getting its link onto the clipboard.
 *
 * The share button used to call navigator.clipboard and swallow the error.
 * navigator.clipboard only exists in a secure context (https or localhost), so
 * on the intranet deployment (plain http on a LAN IP) every press threw, was
 * caught, and the button did nothing at all. copyText() now falls back to the
 * selection-based copy that still works there, and reports failure instead of
 * hiding it.
 */
import type { Lang } from './i18n';

export type ShareTargetId = 'x' | 'line' | 'facebook' | 'weibo';

export interface ShareTarget {
  id: ShareTargetId;
  /** Brand name as the brand writes it in Latin script; the menu localises Weibo's (微博). */
  label: string;
  href: string;
}

const enc = encodeURIComponent;

/** Web share intents, ordered by where the reader's language is most used. */
export function shareTargets(url: string, text: string, lang: Lang): ShareTarget[] {
  const all: Record<ShareTargetId, ShareTarget> = {
    x: { id: 'x', label: 'X', href: `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}` },
    line: { id: 'line', label: 'LINE', href: `https://social-plugins.line.me/lineit/share?url=${enc(url)}` },
    facebook: { id: 'facebook', label: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}` },
    weibo: { id: 'weibo', label: 'Weibo', href: `https://service.weibo.com/share/share.php?url=${enc(url)}&title=${enc(text)}` },
  };
  const order: Record<Lang, ShareTargetId[]> = {
    zh: ['weibo', 'x', 'line', 'facebook'],
    ja: ['line', 'x', 'facebook', 'weibo'],
    en: ['x', 'facebook', 'line', 'weibo'],
  };
  return order[lang].map((id) => all[id]);
}

/**
 * True when a link on this host can only be opened from the same network:
 * localhost, private IPv4 ranges, link-local, and .local / .internal names.
 * Posting such a link to a social network sends people to a dead end.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) {
    return true;
  }
  if (h === '::1' || h.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(h)) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Copy text to the clipboard; resolves false (never throws) if nothing worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the selection copy */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    area.style.pointerEvents = 'none';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
