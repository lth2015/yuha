/**
 * Totals by language and by scene for the dashboard's campaign table
 * (docs/ITERATION_EN_JA_MV.md). Read from the source name, written
 * `<channel>-<scene>-<lang>-<n>` (`x-birthday-en-1`, `seo-travel-ja`); a name
 * not written that way counts under neither. Pure, so tests/funnel-rollup.test.ts
 * can pin it.
 */
export interface FunnelRow {
  visitors: number;
  trials: number;
  signups: number;
  madeASong: number;
  madeAVideo: number;
  paid: number;
  revenueJpy: number;
}

const SCENES = ['home', 'birthday', 'travel', 'love', 'thanks', 'miss', 'memory', 'cheer'] as const;
const LANGS = ['en', 'ja', 'zh'] as const;

export function sourceParts(source: string): { scene: string | null; lang: string | null } {
  const parts = source.split('-');
  const lang = parts.find((p) => (LANGS as readonly string[]).includes(p)) ?? null;
  const scene = parts.find((p) => (SCENES as readonly string[]).includes(p)) ?? null;
  return lang && scene ? { scene, lang } : { scene: null, lang: null };
}

const COLUMNS: Array<keyof FunnelRow> = ['visitors', 'trials', 'signups', 'madeASong', 'madeAVideo', 'paid', 'revenueJpy'];

/** One row per language (or scene), in first-seen order; names off the convention last, as `null`. */
export function rollup(rows: Array<FunnelRow & { source: string }>, by: 'lang' | 'scene'): Array<FunnelRow & { key: string | null }> {
  const out = new Map<string | null, FunnelRow & { key: string | null }>();
  for (const r of rows) {
    const key = sourceParts(r.source)[by];
    let t = out.get(key);
    if (!t) out.set(key, (t = { key, visitors: 0, trials: 0, signups: 0, madeASong: 0, madeAVideo: 0, paid: 0, revenueJpy: 0 }));
    for (const c of COLUMNS) t[c] += r[c] ?? 0;
  }
  const named = [...out.values()].filter((r) => r.key !== null);
  const rest = out.get(null);
  return rest ? [...named, rest] : named;
}
