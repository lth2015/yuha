import type { OfficialBgmItem, OfficialBgmLang } from '@yuha/contracts';

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The catalogue's language for the page's: zh, ja or en. */
function catalogLang(lang: string): OfficialBgmLang {
  return lang === 'ja' || lang === 'en' ? lang : 'zh';
}

/** The title an editor wrote in this language, else the original. */
export function catalogTitle(track: Pick<OfficialBgmItem, 'title' | 'copy'>, lang: string): string {
  return track.copy?.[catalogLang(lang)]?.title?.trim() || track.title;
}

/**
 * The introduction an editor wrote in this language, else one built from the
 * track's own genre, mood and use — words the page already translates, so no
 * track is ever shown without an introduction in the visitor's language.
 */
export function catalogIntro(track: Pick<OfficialBgmItem, 'copy' | 'genre' | 'mood' | 'scenario'>, lang: string, t: T): string {
  const written = track.copy?.[catalogLang(lang)]?.intro?.trim();
  if (written) return written;
  return t('market.intro.template', {
    genre: t(`bgm.genre.${track.genre}`),
    mood: t(`bgm.mood.${track.mood}`),
    scenario: t(`bgm.scenario.${track.scenario}`),
  });
}

/** A score shown with one decimal, or null for none. */
export function catalogRating(rating: number | null | undefined): string | null {
  return typeof rating === 'number' && Number.isFinite(rating) ? rating.toFixed(1) : null;
}
