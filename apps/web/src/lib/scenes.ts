import type { Occasion } from '@yuha/contracts';

/**
 * Scene landing pages (docs/GROWTH_SPEC.md, part one): /birthday, /love and
 * the rest. Each is a public, prerendered page that says what one song can do
 * in that moment and leads into /create with the occasion already chosen.
 *
 * Keys are written out in full, not built from the slug, so check:i18n sees
 * every one of them in use.
 */
export type SceneSlug = 'birthday' | 'travel' | 'love' | 'thanks' | 'miss' | 'memory' | 'cheer';

/**
 * A song shown on a scene page. Only the product owner's own public songs,
 * never a user's: the title and the line below it are written into the
 * prerendered HTML, so they are published the moment the page is built.
 */
export interface SceneExample {
  trackId: string;
  title: string;
  line: string;
}

export interface Scene {
  slug: SceneSlug;
  /** The gift occasion /create opens on; null writes a song for oneself. */
  occasion: Occasion | null;
  name: string;
  /** The page title for search, where it should say more than the nav name (the MV scenes). */
  seoTitle?: string;
  kicker: string;
  title: string;
  body: string;
  cta: string;
  description: string;
  starters: readonly [string, string, string];
  examples: readonly SceneExample[];
  /**
   * The scene leads to a photo MV (docs/ITERATION_EN_JA_MV.md): the page shows
   * how, what is true of it, and its questions answered.
   */
  mv?: boolean;
  /**
   * A finished MV to watch, made by the product owner from a real song and
   * photos they may use. Absent until there is one: no stand-in is shown.
   */
  video?: { src: string; poster: string; lang: 'zh' | 'ja' | 'en' }[];
}

export const SCENES: readonly Scene[] = [
  {
    slug: 'birthday',
    occasion: 'birthday',
    name: 'scene.birthday.name',
    seoTitle: 'scene.birthday.seoTitle',
    kicker: 'scene.birthday.kicker',
    title: 'scene.birthday.title',
    body: 'scene.birthday.body',
    cta: 'scene.birthday.cta',
    description: 'seo.desc.scene.birthday',
    starters: ['scene.birthday.starter1', 'scene.birthday.starter2', 'scene.birthday.starter3'],
    examples: [],
    mv: true,
  },
  {
    slug: 'travel',
    occasion: null,
    name: 'scene.travel.name',
    seoTitle: 'scene.travel.seoTitle',
    kicker: 'scene.travel.kicker',
    title: 'scene.travel.title',
    body: 'scene.travel.body',
    cta: 'scene.travel.cta',
    description: 'seo.desc.scene.travel',
    starters: ['scene.travel.starter1', 'scene.travel.starter2', 'scene.travel.starter3'],
    examples: [],
    mv: true,
  },
  {
    slug: 'love',
    occasion: 'love',
    name: 'scene.love.name',
    kicker: 'scene.love.kicker',
    title: 'scene.love.title',
    body: 'scene.love.body',
    cta: 'scene.love.cta',
    description: 'seo.desc.scene.love',
    starters: ['scene.love.starter1', 'scene.love.starter2', 'scene.love.starter3'],
    examples: [],
  },
  {
    slug: 'thanks',
    occasion: 'thanks',
    name: 'scene.thanks.name',
    kicker: 'scene.thanks.kicker',
    title: 'scene.thanks.title',
    body: 'scene.thanks.body',
    cta: 'scene.thanks.cta',
    description: 'seo.desc.scene.thanks',
    starters: ['scene.thanks.starter1', 'scene.thanks.starter2', 'scene.thanks.starter3'],
    examples: [],
  },
  {
    slug: 'miss',
    occasion: 'miss',
    name: 'scene.miss.name',
    kicker: 'scene.miss.kicker',
    title: 'scene.miss.title',
    body: 'scene.miss.body',
    cta: 'scene.miss.cta',
    description: 'seo.desc.scene.miss',
    starters: ['scene.miss.starter1', 'scene.miss.starter2', 'scene.miss.starter3'],
    examples: [],
  },
  {
    slug: 'memory',
    occasion: null,
    name: 'scene.memory.name',
    kicker: 'scene.memory.kicker',
    title: 'scene.memory.title',
    body: 'scene.memory.body',
    cta: 'scene.memory.cta',
    description: 'seo.desc.scene.memory',
    starters: ['scene.memory.starter1', 'scene.memory.starter2', 'scene.memory.starter3'],
    examples: [],
  },
  {
    slug: 'cheer',
    occasion: 'cheer',
    name: 'scene.cheer.name',
    kicker: 'scene.cheer.kicker',
    title: 'scene.cheer.title',
    body: 'scene.cheer.body',
    cta: 'scene.cheer.cta',
    description: 'seo.desc.scene.cheer',
    starters: ['scene.cheer.starter1', 'scene.cheer.starter2', 'scene.cheer.starter3'],
    examples: [],
  },
];

export function sceneBySlug(slug: string): Scene | undefined {
  return SCENES.find((s) => s.slug === slug);
}

/**
 * Where a scene's button goes: /create on the scene's occasion, tagged with the
 * scene as a source (lib/visits.ts keeps the first one a browser came with, so
 * this only names visits that arrived without a campaign tag), with an opening
 * line when one was picked.
 */
export function sceneCreateHref(scene: Scene, starter?: string, lang?: string): string {
  const q = new URLSearchParams();
  if (scene.occasion) {
    q.set('gift', '1');
    q.set('occasion', scene.occasion);
  }
  if (starter && scene.starters.includes(starter)) q.set('starter', starter);
  // `scene-<slug>-<lang>`: the dashboard's totals read the scene and language from it (lib/funnel.ts).
  q.set('src', lang ? `scene-${scene.slug}-${lang}` : `scene-${scene.slug}`);
  return `/create?${q.toString()}`;
}

/**
 * The opening lines /create offers for an occasion, or one a link may put in
 * the description box (`?starter=`). Only these keys: a link cannot write any
 * text it likes into somebody's form.
 */
export function startersFor(occasion: Occasion | null): readonly string[] {
  if (occasion === 'christmas') return ['holiday.xmas.starter1', 'holiday.xmas.starter2', 'holiday.xmas.starter3'];
  if (occasion === 'new_year') return ['holiday.newyear.starter1', 'holiday.newyear.starter2', 'holiday.newyear.starter3'];
  return SCENES.find((s) => s.occasion !== null && s.occasion === occasion)?.starters ?? [];
}

export function isStarterKey(key: string | null): key is string {
  return !!key && SCENES.some((s) => s.starters.includes(key));
}

/**
 * The "try one first, no sign-up" entry on a scene page: the home composer,
 * tagged like the create button (PR #122 review, PR122-04). lib/visits.ts
 * keeps the first tag a browser came with, so an ad's visitor keeps the ad's.
 */
export function sceneTryHref(scene: Scene, lang: string): string {
  return `/?src=scene-${scene.slug}-${lang}`;
}
