import { OCCASIONS, PROMPT_MAX_CODEPOINTS, type Occasion } from '@yuha/contracts';
import { clampToCodePoints } from './codepoints';
import { isStarterKey } from './scenes';

interface LinkFields {
  prompt: string;
  gift: boolean;
  giftOccasion: Occasion | null;
}

/**
 * What a link into /create changes in the draft it opens on.
 *
 * - `?gift=1&occasion=…` opens "for someone" on that occasion. The link's
 *   occasion wins over one left in the stored draft: somebody who came from
 *   /birthday with a 「谢谢你」 draft left over meant a birthday song.
 * - `?starter=<key>` puts one opening line in the description (scene pages,
 *   docs/GROWTH_SPEC.md). Only a known dictionary key, so a link cannot type
 *   whatever it likes into somebody's form; added once, after what is there.
 */
export function applyCreateLink<D extends LinkFields>(start: D, params: URLSearchParams, t: (key: string) => string): D {
  let next = start;
  const starter = params.get('starter');
  if (isStarterKey(starter)) {
    const opening = t(starter);
    if (!next.prompt.includes(opening)) {
      const prompt = next.prompt.trim() ? `${next.prompt.trimEnd()}\n${opening}` : opening;
      next = { ...next, prompt: clampToCodePoints(prompt, PROMPT_MAX_CODEPOINTS) };
    }
  }
  if (params.get('gift') !== '1') return next;
  const asked = params.get('occasion');
  const occasion = (OCCASIONS as readonly string[]).includes(asked ?? '') ? (asked as Occasion) : null;
  return { ...next, gift: true, giftOccasion: occasion ?? next.giftOccasion };
}
