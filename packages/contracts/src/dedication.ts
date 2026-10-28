import { z } from 'zod';

/**
 * A song written for somebody (docs/GIFT_AND_SHARE_SPEC.md).
 *
 * Who it is for and why travel with the request into the lyric writer, so the
 * song itself is about them, and stay on the song so its page can open with
 * them. The note is shown to anybody holding the link, so it is screened like
 * a description before anything is spent.
 */
export const OCCASIONS = ['birthday', 'thanks', 'sorry', 'love', 'miss', 'farewell', 'cheer', 'other'] as const;
export const Occasion = z.enum(OCCASIONS);
export type Occasion = z.infer<typeof Occasion>;

export const DEDICATION_TO_MAX = 20;
export const DEDICATION_NOTE_MAX = 120;

const oneLine = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(/\s+/g, ' ').trim())
    .refine((v) => [...v].length <= max, { message: `at most ${max} characters` });

export const dedicationSchema = z.object({
  to: oneLine(DEDICATION_TO_MAX).refine((v) => v.length > 0, { message: 'who the song is for is required' }),
  occasion: Occasion,
  note: oneLine(DEDICATION_NOTE_MAX).optional().transform((v) => (v ? v : undefined)),
  /** The creator's interface language, which is the language the brief is written in. */
  lang: z.enum(['zh', 'ja', 'en']).default('zh'),
});
export type Dedication = z.infer<typeof dedicationSchema>;

const OCCASION_WORDS: Record<Dedication['lang'], Record<Occasion, string>> = {
  zh: { birthday: '生日', thanks: '感谢', sorry: '道歉', love: '告白', miss: '想念', farewell: '送别', cheer: '加油打气', other: '' },
  ja: { birthday: '誕生日', thanks: '感謝', sorry: 'お詫び', love: '告白', miss: '会いたい気持ち', farewell: 'お別れ', cheer: '応援', other: '' },
  en: { birthday: 'a birthday', thanks: 'saying thank you', sorry: 'saying sorry', love: 'saying I love you', miss: 'missing them', farewell: 'saying goodbye', cheer: 'cheering them on', other: '' },
};

/**
 * One sentence, in the creator's language, telling the lyric writer who the
 * song is for. Appended to the creator's description; the writer keeps the
 * language of what it is given, so a Chinese sentence would turn a Japanese
 * creator's song Chinese.
 */
export function dedicationBrief(d: Dedication): string {
  const why = OCCASION_WORDS[d.lang][d.occasion];
  const note = d.note ? d.note : '';
  switch (d.lang) {
    case 'ja':
      return `「${d.to}」に贈る歌。${why ? `${why}の歌。` : ''}${note ? `伝えたいこと：${note}` : ''}`;
    case 'en':
      return `A song for ${d.to}${why ? `, for ${why}` : ''}.${note ? ` What I want to tell them: ${note}` : ''}`;
    default:
      return `这是一首送给「${d.to}」的歌${why ? `，为了${why}` : ''}。${note ? `想对 TA 说：${note}` : ''}`;
  }
}

/** The creator's description with the dedication appended, as the lyric writer reads it. */
export function withDedication(prompt: string, d: Dedication | null | undefined): string {
  if (!d) return prompt;
  const brief = dedicationBrief(d);
  return prompt ? `${prompt}\n${brief}` : brief;
}
