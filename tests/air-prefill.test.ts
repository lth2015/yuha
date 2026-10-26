/**
 * Phase 3 (docs/AIR_PHASE3_SPEC.md): the parameter card's 「去 YUHA」 opens
 * /create already filled in from the sketch, and nothing is generated or
 * charged until the creator presses the button there.
 *
 * Three pieces, one contract:
 * - apps/air builds the link (it may only import contracts' types, so it
 *   cannot use the schema);
 * - @yuha/contracts says what a valid link is;
 * - apps/web turns a valid link into a draft, in the reader's own language,
 *   and never over a draft the creator already wrote.
 *
 * The link carries enum values only, never text, so a tampered link can at
 * worst pick another valid sketch. No database: pure functions.
 */
import { describe, expect, it } from 'vitest';
import { AIR_SPACES, AIR_TONES, ENERGY_LEVELS, Mood, PROMPT_MAX_CODEPOINTS, TempoHint, parseAirPrefill } from '@yuha/contracts';
import { songUrl } from '../apps/air/src/engine/prefill.js';
import type { Card } from '../apps/air/src/engine/describe.js';
import { AIR_ENERGY_LEVELS } from '../apps/air/src/engine/describe.js';
import { airPrefillPlan } from '../apps/web/src/lib/air-prefill.js';
import { textIn } from '../apps/web/src/lib/i18n.js';

/** Every card the air page can show, as far as the link is concerned. */
function* everyCard(): Generator<Card> {
  for (const mood of Mood.options)
    for (const tempo of TempoHint.options)
      for (const energy of AIR_ENERGY_LEVELS)
        for (const tone of AIR_TONES)
          for (const space of AIR_SPACES) yield { mood, tempo, energy, tone, space, instrumental: true, moodName: { zh: '', ja: '', en: '' }, words: { zh: '', ja: '', en: '' } };
}

/** `t()` as /create has it, in one language; a missing key comes back as the key itself. */
const say = (lang: 'zh' | 'ja' | 'en') => (key: string, vars: Record<string, string> = {}) =>
  textIn(lang, key).replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `<<${k}>>`);

describe('the link the air page builds', () => {
  it('goes to /create on yuha.studio and carries only the air parameter', () => {
    const url = new URL(songUrl(everyCard().next().value!));
    expect(url.origin).toBe('https://yuha.studio');
    expect(url.pathname).toBe('/create');
    expect([...url.searchParams.keys()]).toEqual(['air']);
    expect(url.hash).toBe('');
  });

  it('is accepted by the contract for every card the page can show, and says the same thing back', () => {
    let n = 0;
    for (const card of everyCard()) {
      const parsed = parseAirPrefill(new URL(songUrl(card)).searchParams.get('air'));
      expect(parsed).toEqual({ mood: card.mood, tempo: card.tempo, energy: card.energy.id, tone: card.tone, space: card.space });
      n += 1;
    }
    expect(n).toBe(8 * 3 * 3 * 3 * 2);
  });
});

describe('what the contract accepts', () => {
  const good = '1-calm-slow-mellow-soft-wide';

  it('accepts a well-formed link', () => {
    expect(parseAirPrefill(good)).toEqual({ mood: 'calm', tempo: 'slow', energy: 'mellow', tone: 'soft', space: 'wide' });
  });

  it('rejects anything else whole, without throwing', () => {
    for (const bad of [
      null,
      '',
      '2-calm-slow-mellow-soft-wide', // unknown version
      '1-angry-slow-mellow-soft-wide', // unknown mood
      '1-calm-slow-0.7-soft-wide', // energy between the levels
      '1-calm-slow-mellow-soft', // missing a part
      '1-calm-slow-mellow-soft-wide-extra', // one too many
      `1-calm-slow-mellow-soft-wide${'x'.repeat(200)}`,
      '1-CALM-slow-mellow-soft-wide',
      '1-calm-slow-mellow-soft-wide\n',
      '1-<script>-slow-mellow-soft-wide',
    ]) {
      expect(parseAirPrefill(bad)).toBeNull();
    }
  });

  it('knows the same three energies the generation contract does', () => {
    expect(AIR_ENERGY_LEVELS).toEqual(ENERGY_LEVELS);
  });
});

describe('the draft /create makes of it', () => {
  const empty = { prompt: '', lyrics: '' };

  it('does nothing without the parameter', () => {
    expect(airPrefillPlan(null, empty, say('zh'))).toEqual({ kind: 'none' });
  });

  it('fills an instrumental at the sketch’s energy, described in words, with AI lyrics', () => {
    const plan = airPrefillPlan('1-calm-slow-mellow-soft-wide', empty, say('zh'));
    expect(plan).toEqual({
      kind: 'fill',
      fields: { prompt: '一段柔和、开阔、舒缓的纯音乐，情绪平静。', instrumental: true, energy: 0.2, lyricsBy: 'ai', lyrics: '' },
    });
  });

  it('describes every sketch in all three languages, within the prompt limit, with no missing words', () => {
    for (const lang of ['zh', 'ja', 'en'] as const) {
      for (const card of everyCard()) {
        const param = new URL(songUrl(card)).searchParams.get('air');
        const plan = airPrefillPlan(param, empty, say(lang));
        if (plan.kind !== 'fill') throw new Error(`${lang} ${param}: ${plan.kind}`);
        expect(plan.fields.prompt).not.toMatch(/<<|\{|undefined|create\.air/);
        expect([...plan.fields.prompt].length).toBeLessThanOrEqual(PROMPT_MAX_CODEPOINTS);
        expect(plan.fields.energy).toBe(card.energy.value);
      }
    }
  });

  it('says it in the reader’s language, not one language for all', () => {
    const prompts = (['zh', 'ja', 'en'] as const).map((lang) => {
      const plan = airPrefillPlan('1-warm-medium-medium-bright-close', empty, say(lang));
      return plan.kind === 'fill' ? plan.fields.prompt : plan.kind;
    });
    expect(new Set(prompts).size).toBe(3);
  });

  it('never overwrites a draft the creator wrote: it asks', () => {
    for (const stored of [{ prompt: '我自己的描述', lyrics: '' }, { prompt: '', lyrics: '[Verse]\n我写的词' }]) {
      const plan = airPrefillPlan('1-calm-slow-mellow-soft-wide', stored, say('zh'));
      expect(plan.kind).toBe('conflict');
    }
  });

  it('treats a draft of only spaces as empty', () => {
    expect(airPrefillPlan('1-calm-slow-mellow-soft-wide', { prompt: '  \n', lyrics: ' ' }, say('zh')).kind).toBe('fill');
  });

  it('ignores a tampered link whole and says so', () => {
    expect(airPrefillPlan('1-calm-slow-mellow-soft-wide-<b>', empty, say('zh'))).toEqual({ kind: 'invalid' });
  });
});
