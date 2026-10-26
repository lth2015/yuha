/**
 * Phase 3: where 「去 YUHA 把它写成一首歌」 goes. /create on yuha.studio, with
 * the card's values in one `air` parameter that /create turns into a filled
 * form (format and validation: @yuha/contracts air.ts). Nothing is generated
 * or charged until the creator presses the button there.
 *
 * Built with `new URL` and checked, not concatenated (CLAUDE.md, "Verifying").
 */
import type { AIR_PREFILL_VERSION } from '@yuha/contracts';
import type { Card } from './describe.ts';

const YUHA = 'https://yuha.studio';
/** Copied, not imported: a runtime import would bring zod into the page. The type keeps it in step. */
const VERSION: typeof AIR_PREFILL_VERSION = '1';

export function songUrl(card: Card): string {
  const url = new URL('/create', YUHA);
  url.searchParams.set('air', [VERSION, card.mood, card.tempo, card.energy.id, card.tone, card.space].join('-'));
  if (url.origin !== YUHA) throw new Error('songUrl: the link left yuha.studio');
  return url.href;
}
