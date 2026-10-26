/**
 * The parameter card (#32): a sketch said back in words, in the vocabulary a
 * real song request uses — the rehearsal for phase 3, when these values become
 * the request.
 *
 * Only types come from @yuha/contracts: a runtime import would bring zod into
 * a page whose first sound must arrive at once. tests/air-describe.test.ts
 * checks at runtime that every value said here is one the contract knows.
 *
 * What is measured, over the frames where a finger was down (and only those):
 * height → how bright; speed and the preset's tempo → energy and pace;
 * openness or a second finger → how wide. A minor preset (夜) turns the quiet
 * moods sad rather than calm.
 */
import type { EnergyLevelId, Mood, TempoHint } from '@yuha/contracts';
import { PRESETS } from './presets.ts';
import type { Sketch } from './session.ts';

/**
 * The only three energies the music service can tell apart (contracts'
 * ENERGY_LEVELS, copied here to keep zod out of the page; the test fails if
 * they drift). A card never shows a float in between: it would change nothing.
 */
export const AIR_ENERGY_LEVELS = [
  { id: 'mellow', value: 0.2 },
  { id: 'medium', value: 0.5 },
  { id: 'strong', value: 0.85 },
] as const satisfies readonly { id: EnergyLevelId; value: number }[];

type Lang = 'zh' | 'ja' | 'en';
type Words = Record<Lang, string>;

export type Card = {
  mood: Mood;
  moodName: Words;
  tempo: TempoHint;
  energy: (typeof AIR_ENERGY_LEVELS)[number];
  instrumental: true;
  /** One line: how bright, how wide, how it moves. */
  words: Words;
};

const MOOD_NAMES: Record<Mood, Words> = {
  calm: { zh: '平静', ja: '穏やか', en: 'calm' },
  dreamy: { zh: '梦幻', ja: '夢見るような', en: 'dreamy' },
  warm: { zh: '温暖', ja: 'あたたかい', en: 'warm' },
  melancholic: { zh: '忧伤', ja: '切ない', en: 'melancholic' },
  confident: { zh: '自信', ja: '堂々と', en: 'confident' },
  playful: { zh: '轻快', ja: '軽やか', en: 'playful' },
  tense: { zh: '紧张', ja: '張りつめた', en: 'tense' },
  uplifting: { zh: '昂扬', ja: '高揚', en: 'uplifting' },
};

const BRIGHT: Record<'bright' | 'soft' | 'deep', Words> = {
  bright: { zh: '明亮', ja: '明るく', en: 'bright' },
  soft: { zh: '柔和', ja: 'やわらかく', en: 'soft' },
  deep: { zh: '深沉', ja: '深く', en: 'deep' },
};
const SPACE: Record<'wide' | 'close', Words> = {
  wide: { zh: '开阔', ja: '広がり', en: 'wide' },
  close: { zh: '亲密', ja: '寄り添い', en: 'close' },
};
const MOTION: Record<TempoHint, Words> = {
  slow: { zh: '舒缓', ja: 'ゆったりと', en: 'unhurried' },
  medium: { zh: '中速流动', ja: '流れるように', en: 'flowing' },
  fast: { zh: '轻快跃动', ja: '弾むように', en: 'lively' },
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function describeSketch(sketch: Sketch): Card {
  const preset = PRESETS.find((p) => p.id === sketch.presetId) ?? PRESETS[0]!;
  const down = sketch.frames.filter((f) => f.active);
  const height = mean(down.map((f) => f.y));
  const motion = mean(down.map((f) => f.speed));
  const open = mean(down.map((f) => f.openness));
  const twoFingers = mean(down.map((f) => (f.spread === null ? 0 : 1)));
  const wide = open >= 0.5 || twoFingers >= 0.3;
  const minor = preset.scale.includes(3);

  // The preset's tempo counts too: the same hand is livelier at 104 bpm than at 60.
  const energyScore = clamp01(0.65 * motion + 0.35 * ((preset.bpm - 60) / 44));
  // The service's own boundaries (deploy/dgx/music/server/app.py, build_tags_v2).
  const energy = AIR_ENERGY_LEVELS[energyScore < 0.35 ? 0 : energyScore > 0.7 ? 2 : 1];

  const pace = preset.bpm * (0.7 + 0.6 * motion);
  const tempo: TempoHint = pace < 72 ? 'slow' : pace > 105 ? 'fast' : 'medium';

  const bright = height >= 0.55;
  let mood: Mood;
  if (energyScore >= 0.62) mood = bright ? (wide ? 'uplifting' : 'playful') : minor || height < 0.35 ? 'tense' : 'confident';
  else if (energyScore <= 0.32) mood = bright ? 'dreamy' : minor ? 'melancholic' : 'calm';
  else if (minor) mood = height < 0.5 ? 'melancholic' : 'dreamy';
  else mood = height >= 0.6 ? 'confident' : 'warm';

  const b = BRIGHT[height >= 0.6 ? 'bright' : height < 0.4 ? 'deep' : 'soft'];
  const s = SPACE[wide ? 'wide' : 'close'];
  const m = MOTION[tempo];
  return {
    mood,
    moodName: MOOD_NAMES[mood],
    tempo,
    energy,
    instrumental: true,
    words: { zh: `${b.zh}、${s.zh}、${m.zh}`, ja: `${b.ja}、${s.ja}、${m.ja}`, en: `${b.en}, ${s.en}, ${m.en}` },
  };
}
