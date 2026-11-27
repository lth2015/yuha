import { z } from 'zod';
import type { OfficialBgmProvenance } from './official-bgm-batch.js';
import { BGM_GENRES, BGM_MOODS, BGM_SCENARIOS } from './bgm.js';

export const officialBgmMetadata = z.object({
  title: z.string().trim().min(1).max(120),
  genre: z.enum(BGM_GENRES),
  scenario: z.enum(BGM_SCENARIOS),
  mood: z.enum(BGM_MOODS),
});
export type OfficialBgmMetadata = z.infer<typeof officialBgmMetadata>;

export const OFFICIAL_BGM_ACTIONS = ['review', 'publish', 'archive'] as const;

export const officialBgmAction = z.object({
  action: z.enum(OFFICIAL_BGM_ACTIONS),
  reason: z.string().trim().min(5).max(500),
});
export type OfficialBgmAction = z.infer<typeof officialBgmAction>;
export type OfficialBgmState = 'draft' | 'reviewed' | 'published' | 'archived';

export const OFFICIAL_BGM_TRANSITIONS: Record<OfficialBgmState, Partial<Record<OfficialBgmAction['action'], OfficialBgmState>>> = {
  draft: { review: 'reviewed' },
  reviewed: { publish: 'published' },
  published: { archive: 'archived' },
  archived: { review: 'reviewed' },
};

/** The catalogue's languages: an editor may write a title and an introduction in each. */
export const OFFICIAL_BGM_LANGS = ['zh', 'ja', 'en'] as const;
export type OfficialBgmLang = (typeof OFFICIAL_BGM_LANGS)[number];
export const OFFICIAL_BGM_INTRO_MAX = 400;
export const OFFICIAL_BGM_TAGS_MAX = 8;

const copyEntry = z.object({
  title: z.string().trim().max(120).default(''),
  intro: z.string().trim().max(OFFICIAL_BGM_INTRO_MAX).default(''),
});
/**
 * What an editor writes about one catalogue track (migration 0044). A
 * language left empty falls back to the original title and a template intro,
 * so a track is never shown without words.
 */
export const officialBgmCatalogEdit = z.object({
  copy: z.object({ zh: copyEntry, ja: copyEntry, en: copyEntry }).partial().default({}),
  tags: z.array(z.string().trim().min(1).max(24)).max(OFFICIAL_BGM_TAGS_MAX).default([]),
  /** "YUHA 推荐指数": an editorial score, one decimal, 1.0–5.0. Never a user rating. */
  rating: z.number().min(1).max(5).multipleOf(0.1).nullable().default(null),
});
export type OfficialBgmCatalogEdit = z.infer<typeof officialBgmCatalogEdit>;
export type OfficialBgmCopy = Partial<Record<OfficialBgmLang, { title: string; intro: string }>>;

/** Approve and publish every draft or reviewed track at once (product owner, 2026-11-27). */
export const officialBgmPublishAll = z.object({
  reason: z.string().trim().min(5).max(500),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export type OfficialBgmBulkChange = z.infer<typeof officialBgmPublishAll>;
export type OfficialBgmPublicationQueue = { count: number; revision: string };
export type OfficialBgmBulkResult = {
  published: number;
  failed: Array<{ id: string; title: string; reason: 'preview_missing' | 'state_changed' | 'save_failed'; error: string }>;
};

export interface OfficialBgmItem extends OfficialBgmMetadata {
  id: string;
  durationSeconds: number;
  previewSeconds: number;
  copy: OfficialBgmCopy;
  tags: string[];
  /** YUHA's editorial recommendation, out of 5; null when none is set. */
  rating: number | null;
}

export interface OfficialBgmAdminItem extends OfficialBgmItem {
  state: OfficialBgmState;
  sourceKey: string;
  previewStartSeconds: number;
  masterFormat: 'mp3' | 'wav';
  provenance: OfficialBgmProvenance | null;
  hasCover: boolean;
}

/**
 * Style tags from a batch's free-text style ("lo-fi, piano / chill"): split on
 * commas, slashes and the CJK list marks, trimmed, de-duplicated, at most
 * OFFICIAL_BGM_TAGS_MAX of at most 24 characters. Empty for none.
 */
export function officialBgmStyleTags(style: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of (style ?? '').split(/[,，、/／;；|]+/u)) {
    const tag = raw.trim().slice(0, 24);
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out.slice(0, OFFICIAL_BGM_TAGS_MAX);
}
