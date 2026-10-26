/**
 * Every word the instrument shows, in the three languages the main site has.
 * Picked from the visitor's own language list (a hosted frame passes no query
 * string, and nothing is stored, so there is no switcher to remember a choice).
 *
 * tests/air-i18n.test.ts fails if a language lacks a key, a placeholder
 * differs, the page names a key that does not exist, or a sentence is written
 * straight into the markup or a script instead of here.
 */
export const LANGS = ['zh', 'ja', 'en'] as const;
export type Lang = (typeof LANGS)[number];

const zh = {
  title: 'YUHA 空气作曲',
  'stage.aria': '空气作曲：触碰并移动手指来演奏，越往上声音越高，动得越快音符越密。也可以按住空格键，用方向键移动。',
  hint: '触碰，让感觉先有声音',
  done: '完成',
  'ended.length': '你的 {n} 秒',
  replay: '回放',
  stop: '停止',
  again: '重来',
  share: '复制链接',
  toSong: '让它成为一首歌',
  'shareUrl.aria': '分享链接',
  'shared.length': '一段空气作曲 · {n} 秒',
  listen: '聆听',
  own: '自己来一段',
  'card.eyebrow': '你的草图',
  'card.mood': '情绪',
  'card.tempo': '速度',
  'card.energy': '能量',
  'card.vocals': '人声',
  'card.instrumental': '纯音乐',
  'card.go': '去 YUHA 把它写成一首歌',
  'card.free': '这个页面不收费，也不消耗 Credit。',
  'card.back': '返回',
  'tempo.slow': '慢',
  'tempo.medium': '中速',
  'tempo.fast': '快',
  'energy.mellow': '舒缓',
  'energy.medium': '适中',
  'energy.strong': '强烈',
  'toast.tooShort': '再多玩一会儿，再听回放',
  'toast.copied': '链接已复制，发给朋友吧',
  'toast.copyByHand': '长按上面的链接，全选后复制',
  'toast.broken': '这个链接打不开了，来演奏你自己的吧',
};

export type Key = keyof typeof zh;

export const STRINGS: Record<Lang, Record<Key, string>> = {
  zh,
  ja: {
    title: 'YUHA エア作曲',
    'stage.aria': 'エア作曲：画面に触れて指を動かすと演奏できます。上へ動かすほど音が高く、速く動かすほど音が細かくなります。スペースキーを押したまま矢印キーで動かすこともできます。',
    hint: '触れて、気持ちに音を',
    done: '完了',
    'ended.length': 'あなたの {n} 秒',
    replay: '再生',
    stop: '停止',
    again: 'もう一度',
    share: 'リンクをコピー',
    toSong: 'これを一曲にする',
    'shareUrl.aria': '共有リンク',
    'shared.length': 'エア作曲 · {n} 秒',
    listen: '聴く',
    own: '自分も演奏する',
    'card.eyebrow': 'あなたのスケッチ',
    'card.mood': 'ムード',
    'card.tempo': 'テンポ',
    'card.energy': 'エネルギー',
    'card.vocals': 'ボーカル',
    'card.instrumental': 'インスト',
    'card.go': 'YUHA で一曲にする',
    'card.free': 'このページは無料で、Credit も消費しません。',
    'card.back': '戻る',
    'tempo.slow': 'ゆっくり',
    'tempo.medium': '中くらい',
    'tempo.fast': '速い',
    'energy.mellow': 'おだやか',
    'energy.medium': 'ふつう',
    'energy.strong': '力強い',
    'toast.tooShort': 'もう少し演奏してから聴いてみましょう',
    'toast.copied': 'リンクをコピーしました',
    'toast.copyByHand': '上のリンクを長押しし、すべて選択してコピーしてください',
    'toast.broken': 'このリンクは開けません。自分で演奏してみましょう',
  },
  en: {
    title: 'YUHA Air composition',
    'stage.aria': 'Air composition: touch and move your finger to play. Higher sounds higher; faster plays more notes. You can also hold Space and move with the arrow keys.',
    hint: 'Touch, and let a feeling find its sound',
    done: 'Done',
    'ended.length': 'Your {n} seconds',
    replay: 'Replay',
    stop: 'Stop',
    again: 'Start over',
    share: 'Copy link',
    toSong: 'Make it a song',
    'shareUrl.aria': 'Share link',
    'shared.length': 'An air composition · {n} s',
    listen: 'Listen',
    own: 'Play your own',
    'card.eyebrow': 'Your sketch',
    'card.mood': 'Mood',
    'card.tempo': 'Tempo',
    'card.energy': 'Energy',
    'card.vocals': 'Vocals',
    'card.instrumental': 'Instrumental',
    'card.go': 'Make it a song on YUHA',
    'card.free': 'This page is free and spends no Credit.',
    'card.back': 'Back',
    'tempo.slow': 'Slow',
    'tempo.medium': 'Medium',
    'tempo.fast': 'Fast',
    'energy.mellow': 'Mellow',
    'energy.medium': 'Medium',
    'energy.strong': 'Strong',
    'toast.tooShort': 'Play a little longer, then listen back',
    'toast.copied': 'Link copied. Send it to a friend',
    'toast.copyByHand': 'Press and hold the link above, select all, and copy',
    'toast.broken': 'This link can’t be opened. Play your own instead',
  },
};

/** The first of the visitor's languages the page has; English if none. */
export function pickLang(preferred: readonly string[]): Lang {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if ((LANGS as readonly string[]).includes(base ?? '')) return base as Lang;
  }
  return 'en';
}

export const format = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''));
