import { z } from 'zod';
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

export interface OfficialBgmItem extends OfficialBgmMetadata {
  id: string;
  durationSeconds: number;
  previewSeconds: number;
}

export interface OfficialBgmAdminItem extends OfficialBgmItem {
  state: OfficialBgmState;
  sourceKey: string;
  previewStartSeconds: number;
}
