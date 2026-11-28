import { urlLang } from './seo';
import type { Dict } from './i18n-dict';
import { Fragment, createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Trilingual UI (acceptance §6): zh-CN is the development baseline, ja for
 * the Japan launch, en for international. One slogan per language, from the
 * brand doc — zh 让心动，有回声。/ ja ときめきに、響きを。/ en Let a feeling echo.
 * Missing keys fall back to Chinese rather than leaking raw ids.
 */
export type Lang = 'zh' | 'ja' | 'en';

const LANG_KEY = 'yuha.lang';
export const LANGS: Array<{ code: Lang; label: string }> = [
  { code: 'zh', label: '中' },
  { code: 'ja', label: '日' },
  { code: 'en', label: 'EN' },
];

/*
 * One dictionary per language, each in its own module (i18n-zh.ts and so on),
 * fetched when a language is first needed: about 30 KB each gzipped, and a
 * visitor reads one. The visitor's language is loaded before the first render
 * (main.tsx, loadLang); a switch loads the next one, then switches. The
 * prerender and the tests load all three (loadAllLangs).
 */
const DICTS: Partial<Record<Lang, Dict>> = {};
const LOADERS: Record<Lang, () => Promise<{ default: Dict }>> = {
  zh: () => import('./i18n-zh'),
  ja: () => import('./i18n-ja'),
  en: () => import('./i18n-en'),
};
const isLang = (v: string | null): v is Lang => v === 'zh' || v === 'ja' || v === 'en';

export async function loadLang(lang: Lang): Promise<void> {
  if (DICTS[lang]) return;
  const [dictionary] = await Promise.all([
    LOADERS[lang](),
    // The local Simplified Chinese face is only needed when the reader uses Chinese.
    lang === 'zh' && !import.meta.env.SSR
      ? import('@fontsource-variable/noto-sans-sc').catch(() => undefined)
      : undefined,
  ]);
  DICTS[lang] = dictionary.default;
}

export async function loadAllLangs(): Promise<void> {
  await Promise.all(LANGS.map((l) => loadLang(l.code)));
}

/** The language the first render will use; main.tsx loads its dictionary first. */
export function initialLang(): Lang {
  return detectLang();
}

function detectLang(): Lang {
  // A link that names a language wins, and is remembered: it is how each
  // public page has an address per language (docs/SEO_SPEC.md).
  const asked = typeof location === 'undefined' ? null : urlLang(location.search);
  if (asked) {
    try {
      localStorage.setItem(LANG_KEY, asked);
    } catch {
      /* ignore */
    }
    return asked;
  }
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (isLang(saved)) return saved;
  } catch {
    /* ignore */
  }
  const nav = navigator.language?.toLowerCase() ?? 'zh';
  if (nav.startsWith('ja')) return 'ja';
  if (nav.startsWith('en')) return 'en';
  return 'zh';
}

interface I18nApi {
  lang: Lang;
  setLang(lang: Lang): void;
  t(key: string, params?: Record<string, string | number>): string;
}

const I18nContext = createContext<I18nApi | null>(null);

export function I18nProvider({ children, initialLang }: { children: ReactNode; initialLang?: Lang }) {
  // `initialLang` is for the build-time render of public pages (prerender.tsx),
  // which has no location, storage or browser to ask.
  const [lang, setLangState] = useState<Lang>(() => initialLang ?? detectLang());

  const setLang = useCallback((next: Lang) => {
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      /* ignore */
    }
    // The page keeps its language until the next one has arrived, rather than
    // showing raw keys for the moment in between.
    void loadLang(next).then(() => setLangState(next));
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang === 'ja' ? 'ja' : 'en';
  }, [lang]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => {
      let text = DICTS[lang]?.[key] ?? DICTS.zh?.[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) text = text.replaceAll(`{${k}}`, String(v));
      }
      return text;
    },
    [lang],
  );

  const api = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={api}>{children}</I18nContext.Provider>;
}

/**
 * One dictionary string in a fixed language. For the 特商法 page, which stays
 * Japanese whatever the reader chose, and must say exactly what the
 * confirmation screen says in Japanese — reading the same entry is what keeps
 * the two statutory surfaces from drifting apart.
 */
export function textIn(lang: Lang, key: string): string {
  return DICTS[lang]?.[key] ?? key;
}

/**
 * A translated sentence whose `{slots}` are elements rather than text.
 *
 * `t()` only substitutes strings, so a sentence with a link in it — "I agree to
 * the Terms and Privacy Policy" — used to be written in English straight into
 * the JSX, because a translated string had nowhere to put the `<Link>`. Word
 * order is the reason it cannot be three concatenated keys: Japanese puts both
 * links first (「{terms}と{privacy}に同意します」), English puts them last.
 * check-i18n already requires every language to carry the same placeholders, so
 * a translation cannot silently drop a link.
 *
 * Call `t(key, params)` first for the text slots, then this for the elements.
 */

export function rich(text: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{[a-zA-Z]+\})/).map((part, i) => {
    const slot = /^\{([a-zA-Z]+)\}$/.exec(part)?.[1];
    return slot !== undefined && slot in nodes ? <Fragment key={i}>{nodes[slot]}</Fragment> : part;
  });
}

export function useI18n(): I18nApi {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside an I18nProvider');
  return ctx;
}
