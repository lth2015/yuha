import { LYRICS_MAX_CODEPOINTS, PROMPT_MAX_CODEPOINTS } from '@yuha/contracts';

/**
 * Input pre-check (SEC-07 / AI-03 heritage).
 *
 * Deliberately narrow. It blocks the categories our supplier terms actually
 * forbid — named artists/songs, quoted lyrics of existing works, voice
 * imitation, reference-media URLs — and lets everything else through.
 *
 * The 2026-09 product pivot made sung songs a first-class feature, so plain
 * "add vocals" / "write me lyrics" requests are no longer blocked; what stays
 * blocked is asking for a SPECIFIC person's voice or an existing work.
 *
 * Two things this is NOT:
 *   - a copyright determination. A block means "outside what we accept",
 *     never "you attempted something illegal" (SEC-07 requires the UI to say
 *     so, and every result carries `appealable: true`);
 *   - a guarantee. Passing this check does not make output non-infringing.
 */
export type BlockReason =
  | 'too_long'
  | 'artist_or_title_reference'
  | 'quoted_existing_lyrics'
  | 'voice_imitation'
  | 'reference_media_url'
  | 'personal_information'
  | 'prompt_injection';

export interface SafetyResult {
  allowed: boolean;
  reason: BlockReason | null;
  /** Japanese guidance shown to the user, phrased as a rewrite suggestion. */
  hintKey: string | null;
  /** Every block can be contested; nothing here is an automatic permanent ban. */
  appealable: boolean;
}

const ALLOW: SafetyResult = { allowed: true, reason: null, hintKey: null, appealable: false };

function block(reason: BlockReason, hintKey: string): SafetyResult {
  return { allowed: false, reason, hintKey, appealable: true };
}

/**
 * "〜風", "〜っぽい", "like <name>" combined with a proper-noun-looking token.
 *
 * The Chinese rules below exist because there were none. 「周杰伦风格的歌」 was
 * accepted, charged and generated — the quoted-title rule wants 「…」 or 《…》
 * and Chinese writes the name bare, so nothing matched. A bare name cannot be
 * recognised as a name without a list of names, so these match the *frame* a
 * reference is built in — a title in 《》, or a comparison word — rather than
 * trying to know who is famous.
 */
const STYLE_OF_PATTERNS: RegExp[] = [
  /[「『"][^」』"]{2,40}[」』"]\s*(風|っぽい|みたいな|のような|の曲|そっくり)/,
  /\b(like|in the style of|sounds? like|cover of|remix of)\s+[A-Z][\w.'-]+/i,
  /(の|と)(そっくり|同じ曲|カバー|替え歌)/,
  // 《曲名》 is a title mark in Chinese; its presence is the reference.
  /《[^》]{1,40}》/,
  /*
   * 「X 风格」「像 X 的唱法」 — a comparison to a named performer or work.
   *
   * Not any comparison. 「像清晨一样」 is how people describe a mood, and the
   * first draft refused it: 像 + any two characters + 一样 matched. What marks
   * a reference is that the thing compared to is *musical* — a style, a way of
   * singing, an arrangement — so the comparison rule now requires one of those
   * words rather than any trailing 那样/一样.
   */
  // 的 is optional: 「周杰伦风格的歌」 writes the name straight onto 风格.
  /[\u4e00-\u9fff]{2,10}\s*(的)?\s*(风格|曲风|唱腔|唱法|编曲|編曲)/,
  /(像|仿照|参照|照着|按照)\s*[^。\n]{1,12}\s*的\s*(风格|曲风|唱腔|唱法|编曲|編曲|那种唱)/,
  /(翻唱|改编自|致敬)\s*(这首|那首|原曲)?/,
  // 模仿 + a musical object, as distinct from 模仿雨声 (imitating a sound).
  /模仿\s*(这首|那首|原曲|原唱)/,
];

/**
 * Quoted lyrics of an existing work — not any use of the word "lyrics".
 *
 * Requesting original lyrics is fine, and is a product feature; reproducing
 * identifiable chunks of known songs is not.
 *
 * The Japanese rule here used to be /(の|という)(歌詞| lyrics)/, which matches
 * any noun followed by の歌詞. That blocked 「オリジナルの歌詞」 and
 * 「自分の歌詞」 — the exact thing the composer asks the user to supply — and
 * it was found by a real acceptance run being refused PROMPT_BLOCKED for the
 * lyrics "[Verse]\n検収のための歌詞". The same check runs over the lyrics body,
 * where a bare noun + の + 歌詞 is ordinary writing, not a citation.
 *
 * What is actually worth refusing is a request for a *named* work's lyrics, or
 * an explicit ask to reproduce lyrics verbatim. Those are the four rules below.
 * A long quoted block stays caught by the first pattern regardless of wording.
 */
const QUOTED_LYRICS_PATTERNS: RegExp[] = [
  /[「『"][^」』"]{24,}[」』"]/,
  /\b(lyrics?|words)\s+(of|to|for)\s+[A-Z][\w.'-]+/i,
  // 「名前」の歌詞 — a titled work, quoted, then referred to for its lyrics.
  /[「『][^」』]{1,60}[」』]\s*(という)?\s*(曲|歌|ソング)?\s*の\s*歌詞/,
  // Asking for lyrics to be reproduced rather than written.
  /歌詞\s*を\s*(そのまま|まるごと|丸ごと|全部|引用|コピー|再現)/,
  // Somebody else's, explicitly.
  /(既存|実在|有名|他人)[^。\n]{0,12}歌詞/,
  /(アーティスト|歌手|バンド|アイドル)[^。\n]{0,12}の歌詞/,
  // Chinese. 歌词 on its own is ordinary — the product asks for lyrics — so
  // these need a named work, a verb of copying, or somebody else's.
  /《[^》]{1,40}》\s*(的)?\s*(歌词|歌詞)/,
  /(歌词|歌詞)[^。\n]{0,8}(照搬|照抄|抄过来|抄過來|引用|复制|複製|原封不动)/,
  /(照搬|照抄|引用|复制|複製)[^。\n]{0,8}(歌词|歌詞)/,
  /(原曲|原唱|别人|別人|他人|现有|現有|已有)[^。\n]{0,8}(的)?\s*(歌词|歌詞)/,
];

/**
 * Voice / person imitation and implied endorsement.
 *
 * Japanese puts the object first — 声を真似 — and the first rule reads that
 * order. Chinese puts the verb first, 模仿…的声音, so none of these fired on
 * 「模仿周杰伦的声音唱」 and the request was generated and billed.
 *
 * The Chinese rules below require a *person's* voice, not any imitation:
 * 模仿雨声 (imitate the sound of rain) is an ordinary thing to ask for and
 * must keep working. 声音/嗓音/音色 preceded by a possessive is the shape that
 * means a person.
 */
const VOICE_PATTERNS: RegExp[] = [
  /(声|ボイス)(を)?(真似|まね|模倣|コピー|クローン)/,
  /\b(voice\s*(clone|clon|imitat|impersonat))/i,
  /(公認|オフィシャル|本人)(の)?(声|歌声)/,
  /*
   * 模仿/克隆 … 的嗓音|唱腔|歌声 — a person's voice.
   *
   * 音色 is deliberately absent and 声音 is qualified: 「模仿雨声的那种音色」
   * is an ordinary request about timbre, and the first draft refused it. A
   * screen that rejects ordinary Chinese costs more than one that misses a
   * case — it makes the product look like it cannot read the language.
   * 嗓音, 唱腔, 歌声 and 声线 only describe people; 声音 does not, so it is
   * only matched with a possessive naming whose voice it is.
   */
  /(模仿|模彷|模擬|模拟|克隆|複製|复制)[^。\n]{0,12}(的)?(嗓音|唱腔|歌声|歌聲|声线|聲線)/,
  /(模仿|模彷|模擬|模拟|克隆|複製|复制)\s*[^。\n]{1,10}的\s*(声音|聲音)/,
  // 用 X 的嗓音 / 声线 — borrowing a named person's voice.
  /(用|按照|照)[^。\n]{0,12}的\s*(声音|聲音|嗓音|声线|聲線|唱腔)/,
  // Implied endorsement, the Chinese counterpart of 公認/本人の声.
  /(本人|官方|亲自|親自)[^。\n]{0,6}(演唱|献唱|演繹|演绎|的声音|的歌声)/,
];

const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/i;

/** Rough PII screens; keeps card numbers and addresses out of the model call (SEC-12). */
const PII_PATTERNS: RegExp[] = [
  /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{3,4}\b/, // card-shaped
  /[\w.+-]+@[\w-]+\.[\w.]{2,}/, // email
  /\b\d{3}-?\d{4}\b\s*[都道府県市区町村]/, // JP postal + address
];

/** Attempts to reframe the untrusted text as an instruction to the system. */
const INJECTION_PATTERNS: RegExp[] = [
  /(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior)\s+(instructions?|rules?|prompts?)/i,
  /(system\s*prompt|developer\s*message|上記の指示を無視)/i,
  /\b(you are now|act as|jailbreak|DAN mode)\b/i,
];

/**
 * Content rules, shared; the length rule, not.
 *
 * Lyrics are user text exactly like the description and get the same screening
 * for artist names, quoted works and impersonation. Length is the one rule that
 * legitimately differs — the composer accepts 3000 code points of lyrics and
 * 500 of description — and it used to be shared, because lyrics were simply
 * passed to `checkPrompt`. An ordinary 600-character lyric was refused with
 * "keep the description within the length limit", pointing at a description
 * that was well inside it. Reported from the composer with 478 / 500 on screen.
 */
function check(text: string, maxCodePoints: number, tooLongHint: string): SafetyResult {
  const trimmed = text.trim();
  if (!trimmed) return ALLOW;

  if ([...trimmed].length > maxCodePoints) {
    return block('too_long', tooLongHint);
  }
  return checkContent(trimmed);
}

/** The description field. */
export function checkPrompt(prompt: string): SafetyResult {
  return check(prompt, PROMPT_MAX_CODEPOINTS, 'prompt.tooLong');
}

/** The lyrics field, which is allowed to be much longer. */
export function checkLyrics(lyrics: string): SafetyResult {
  return check(lyrics, LYRICS_MAX_CODEPOINTS, 'lyrics.tooLong');
}

function checkContent(text: string): SafetyResult {
  if (URL_PATTERN.test(text)) {
    // SEC-05: we never accept a reference-music URL, and the server never
    // fetches a user-supplied address.
    return block('reference_media_url', 'prompt.noUrl');
  }
  for (const p of PII_PATTERNS) {
    if (p.test(text)) return block('personal_information', 'prompt.noPersonalInfo');
  }
  for (const p of INJECTION_PATTERNS) {
    if (p.test(text)) return block('prompt_injection', 'prompt.rewriteAsMood');
  }
  for (const p of VOICE_PATTERNS) {
    if (p.test(text)) return block('voice_imitation', 'prompt.noVoiceImitation');
  }
  for (const p of QUOTED_LYRICS_PATTERNS) {
    if (p.test(text)) return block('quoted_existing_lyrics', 'prompt.noExistingLyrics');
  }
  for (const p of STYLE_OF_PATTERNS) {
    if (p.test(text)) return block('artist_or_title_reference', 'prompt.noArtistOrTitle');
  }
  return ALLOW;
}

/**
 * Redacts a prompt for logs. SEC-06: prompts and personal data are never
 * written to application logs in the clear.
 */
export function redactPrompt(prompt: string): string {
  const cp = [...prompt];
  if (cp.length <= 8) return `[redacted ${cp.length}cp]`;
  return `${cp.slice(0, 4).join('')}…[redacted ${cp.length}cp]`;
}
