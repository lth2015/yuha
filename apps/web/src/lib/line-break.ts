// i18n-exempt-file: typographic data (which characters may not open a line), not text shown to anyone
/**
 * Characters a line may not start with, under the Chinese and Japanese
 * line-breaking rules (kinsoku): closing punctuation, small kana and the
 * prolonged-sound mark. Used where text is laid out by hand on a canvas
 * (lib/share-art.ts), which has no CSS `line-break` to do it.
 */
export const NO_LINE_START = new Set([...'，。、．！？：；）」』】》〉’”…～ー々ぁぃぅぇぉっゃゅょァィゥェォッャュョ,.!?:;)]}']);
