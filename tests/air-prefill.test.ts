/**
 * Phase 3 (docs/AIR_PHASE3_SPEC.md): the parameter card's 「去 YUHA」 opens
 * /create already filled in from the sketch, and nothing is generated or
 * charged until the creator presses the button there.
 *
 * Three pieces, one contract:
 * - apps/air builds the link (it may only import contracts' types, so it
 *   cannot use the schema);
 * - @yuha/contracts says what a valid link is;
 * - apps/web turns a valid link into a draft, in the reader's own language;
 *   a draft the creator already wrote is set aside to restore, never lost.
 *
 * Version 2 closes the loop from playing to a sung song: the card lets the
 * player choose a voice (sung: the AI writes the lyrics, as /create already
 * does for any sung request) and the link carries the sketch's shape (arc),
 * which becomes a line of the description the lyrics and music are written
 * from. Version 1 links, already shared, still open.
 *
 * The link carries enum values only, never text, so a tampered link can at
 * worst pick another valid sketch. No database: pure functions.
 */
import { describe, expect, it } from 'vitest';
import { AIR_ARCS, AIR_SPACES, AIR_TONES, AIR_VOICES, ENERGY_LEVELS, Mood, PROMPT_MAX_CODEPOINTS, TempoHint, parseAirPrefill } from '@yuha/contracts';
import { songUrl } from '../apps/air/src/engine/prefill.js';
import type { Card } from '../apps/air/src/engine/describe.js';
import { AIR_ENERGY_LEVELS } from '../apps/air/src/engine/describe.js';
import { airPrefillPlan, withDraftedLyrics } from '../apps/web/src/lib/air-prefill.js';
import { textIn } from '../apps/web/src/lib/i18n.js';

const blank = { zh: '', ja: '', en: '' };

/** Every card the air page can show, as far as the link is concerned. */
function* everyCard(): Generator<Card> {
  for (const mood of Mood.options)
    for (const tempo of TempoHint.options)
      for (const energy of AIR_ENERGY_LEVELS)
        for (const tone of AIR_TONES)
          for (const space of AIR_SPACES)
            for (const arc of AIR_ARCS) yield { mood, tempo, energy, tone, space, arc, instrumental: true, moodName: blank, words: blank };
}

/** `t()` as /create has it, in one language; a missing key comes back as the key itself. */
const say = (lang: 'zh' | 'ja' | 'en') => (key: string, vars: Record<string, string> = {}) =>
  textIn(lang, key).replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `<<${k}>>`);

const param = (card: Card, voice: (typeof AIR_VOICES)[number]) => new URL(songUrl(card, voice)).searchParams.get('air');

describe('the link the air page builds', () => {
  it('goes to /create on yuha.studio and carries only the air parameter', () => {
    const url = new URL(songUrl(everyCard().next().value!, 'sung'));
    expect(url.origin).toBe('https://yuha.studio');
    expect(url.pathname).toBe('/create');
    expect([...url.searchParams.keys()]).toEqual(['air']);
    expect(url.hash).toBe('');
  });

  it('is accepted by the contract for every card and voice, and says the same thing back', () => {
    let n = 0;
    for (const card of everyCard()) {
      for (const voice of AIR_VOICES) {
        expect(parseAirPrefill(param(card, voice))).toEqual({
          mood: card.mood, tempo: card.tempo, energy: card.energy.id, tone: card.tone, space: card.space, arc: card.arc, voice,
        });
        n += 1;
      }
    }
    expect(n).toBe(8 * 3 * 3 * 3 * 2 * 4 * 2);
  });
});

describe('what the contract accepts', () => {
  it('accepts a version 2 link', () => {
    expect(parseAirPrefill('2-calm-slow-mellow-soft-wide-rise-sung')).toEqual({
      mood: 'calm', tempo: 'slow', energy: 'mellow', tone: 'soft', space: 'wide', arc: 'rise', voice: 'sung',
    });
  });

  it('still opens a version 1 link, as the instrumental without an arc it always meant', () => {
    expect(parseAirPrefill('1-calm-slow-mellow-soft-wide')).toEqual({
      mood: 'calm', tempo: 'slow', energy: 'mellow', tone: 'soft', space: 'wide', arc: null, voice: 'inst',
    });
  });

  it('rejects anything else whole, without throwing', () => {
    for (const bad of [
      null,
      '',
      '3-calm-slow-mellow-soft-wide-rise-sung', // unknown version
      '1-calm-slow-mellow-soft-wide-rise-sung', // version 1 has six parts
      '2-calm-slow-mellow-soft-wide', // version 2 has eight
      '2-angry-slow-mellow-soft-wide-rise-sung', // unknown mood
      '2-calm-slow-0.7-soft-wide-rise-sung', // energy between the levels
      '2-calm-slow-mellow-soft-wide-spiral-sung', // unknown arc
      '2-calm-slow-mellow-soft-wide-rise-rap', // unknown voice
      '2-calm-slow-mellow-soft-wide-rise-sung-extra',
      `2-calm-slow-mellow-soft-wide-rise-sung${'x'.repeat(200)}`,
      '2-CALM-slow-mellow-soft-wide-rise-sung',
      '2-calm-slow-mellow-soft-wide-rise-sung\n',
      '2-<script>-slow-mellow-soft-wide-rise-sung',
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

  it('sung: a song with AI lyrics, described with the shape of what was played', () => {
    expect(airPrefillPlan('2-calm-slow-mellow-soft-wide-rise-sung', empty, say('zh'))).toEqual({
      kind: 'fill',
      fields: { prompt: '一首柔和、开阔、舒缓的歌，旋律从低处慢慢扬起，情绪平静。', instrumental: false, energy: 0.2, lyricsBy: 'ai', lyrics: '' },
      setAside: false,
    });
  });

  it('instrumental: no vocals, the same shape', () => {
    expect(airPrefillPlan('2-calm-slow-mellow-soft-wide-fall-inst', empty, say('zh'))).toEqual({
      kind: 'fill',
      fields: { prompt: '一段柔和、开阔、舒缓的纯音乐，旋律从高处缓缓落下，情绪平静。', instrumental: true, energy: 0.2, lyricsBy: 'ai', lyrics: '' },
      setAside: false,
    });
  });

  it('a version 1 link still fills the instrumental it always did', () => {
    expect(airPrefillPlan('1-calm-slow-mellow-soft-wide', empty, say('zh'))).toEqual({
      kind: 'fill',
      fields: { prompt: '一段柔和、开阔、舒缓的纯音乐，情绪平静。', instrumental: true, energy: 0.2, lyricsBy: 'ai', lyrics: '' },
      setAside: false,
    });
  });

  it('describes every sketch and voice in all three languages, within the prompt limit, with no missing words', () => {
    for (const lang of ['zh', 'ja', 'en'] as const) {
      for (const card of everyCard()) {
        for (const voice of AIR_VOICES) {
          const plan = airPrefillPlan(param(card, voice), empty, say(lang));
          if (plan.kind !== 'fill') throw new Error(`${lang} ${param(card, voice)}: ${plan.kind}`);
          expect(plan.fields.prompt).not.toMatch(/<<|\{|undefined|create\.air/);
          expect([...plan.fields.prompt].length).toBeLessThanOrEqual(PROMPT_MAX_CODEPOINTS);
          expect(plan.fields.energy).toBe(card.energy.value);
          expect(plan.fields.instrumental).toBe(voice === 'inst');
        }
      }
    }
  });

  it('says it in the reader’s language, not one language for all', () => {
    const prompts = (['zh', 'ja', 'en'] as const).map((lang) => {
      const plan = airPrefillPlan('2-warm-medium-medium-bright-close-wave-sung', empty, say(lang));
      return plan.kind === 'fill' ? plan.fields.prompt : plan.kind;
    });
    expect(new Set(prompts).size).toBe(3);
  });

  // Pressing 「去 YUHA」 is the creator asking for this sketch. Asking again on
  // arrival left the form on the old draft (人声 after choosing 纯音乐) behind a
  // banner, and every earlier visit from Air leaves such a draft. So the sketch
  // always fills the form, and a written draft is kept to restore, not asked about.
  it('fills from the sketch even over a draft the creator wrote, and says one was set aside', () => {
    for (const stored of [{ prompt: '我自己的描述', lyrics: '' }, { prompt: '', lyrics: '[Verse]\n我写的词' }]) {
      const plan = airPrefillPlan('2-calm-slow-mellow-soft-wide-fall-inst', stored, say('zh'));
      expect(plan.kind).toBe('fill');
      if (plan.kind !== 'fill') return;
      expect(plan.fields.instrumental).toBe(true);
      expect(plan.setAside).toBe(true);
    }
  });

  it('sets nothing aside when the draft was empty or only spaces', () => {
    for (const stored of [empty, { prompt: '  \n', lyrics: ' ' }]) {
      const plan = airPrefillPlan('2-calm-slow-mellow-soft-wide-rise-sung', stored, say('zh'));
      expect(plan.kind === 'fill' && plan.setAside).toBe(false);
    }
  });

  it('ignores a tampered link whole and says so', () => {
    expect(airPrefillPlan('2-calm-slow-mellow-soft-wide-rise-sung-<b>', empty, say('zh'))).toEqual({ kind: 'invalid' });
  });
});

describe('lyrics written ahead, arriving after the page', () => {
  const sung = { instrumental: false, lyrics: '', lyricsBy: 'ai' as const, prompt: 'x' };
  const LYRICS = '[verse]\n晚风吹过湖面';

  it('go into the lyrics box as the creator’s own, so generation sings them as written', () => {
    expect(withDraftedLyrics(sung, LYRICS)).toEqual({ ...sung, lyrics: LYRICS, lyricsBy: 'me' });
  });

  it('never land on an instrumental, or over lyrics the creator started meanwhile', () => {
    const inst = { ...sung, instrumental: true };
    expect(withDraftedLyrics(inst, LYRICS)).toBe(inst);
    const typing = { ...sung, lyrics: '我自己写的第一句', lyricsBy: 'me' as const };
    expect(withDraftedLyrics(typing, LYRICS)).toBe(typing);
  });
});
