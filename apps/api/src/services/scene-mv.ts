import { AppError } from '@yuha/contracts';
import {
  activeSceneMvFor,
  cancelSceneMv,
  createSceneMvDraft,
  getSceneMv,
  getTrack,
  query,
  queueSceneMv,
  replaceDraftShots,
  type SceneMvBudget,
  type SceneMvRow,
  type SceneMvShotRow,
} from '@yuha/db';
import { checkPrompt, shotSecondsFor } from '@yuha/providers';
import type { AppContext } from '../context.js';
import { discardAtService } from './scene-mv-cleanup.js';

/**
 * The AI scene MV, for the song's owner (docs/AI_SCENE_MV_SPEC.md; the page
 * is docs/agents/CODEX_SCENE_MV_UI.md). The records' own rules live in
 * packages/db/src/scene-mvs.ts; this decides who may, and what is shown.
 */
export const SCENE_MV_STYLES = ['neon_rain', 'seaside_sunset', 'soft_watercolor'] as const;
export type SceneMvStyle = (typeof SCENE_MV_STYLES)[number];

/** Four beats per style, in English because the video models follow it best. The owner can rewrite any of them. */
const BEATS: Record<SceneMvStyle, string[]> = {
  neon_rain: [
    'a rain-soaked city street at night, neon signs reflecting on wet asphalt, slow dolly forward',
    'close-up of raindrops running down a window, blurred neon lights behind',
    'an elevated train passing at night, light streaks, gentle camera pan',
    'the city skyline at dawn after the rain, soft pale light',
  ],
  seaside_sunset: [
    'a quiet beach at golden hour, gentle waves, slow pan along the shore',
    'sunlight glittering on the sea surface, close-up, calm',
    'a path through dunes and tall grass swaying in the wind',
    'the sun touching the horizon, warm orange sky, slow push in',
  ],
  soft_watercolor: [
    'a soft watercolour illustration of a small town street in spring, petals drifting',
    'a watercolour window with a cat asleep in the sun, gentle light',
    'a watercolour river under a footbridge, slow drifting camera',
    'a watercolour night sky over rooftops, stars appearing one by one',
  ],
};
const TAIL = 'cinematic, vertical composition, no text, no people in close-up';

/** At most four shots of at most eight seconds: the service draws 1–8 s. */
const MAX_SPAN_SECONDS = 32;

function buildStoryboard(style: SceneMvStyle, description: string | null): string[] {
  return BEATS[style].map((beat) => [description?.trim(), beat, TAIL].filter(Boolean).join('. '));
}

export interface SceneMvView {
  id: string;
  trackId: string;
  status: SceneMvRow['status'];
  style: string;
  clipStart: number;
  clipEnd: number;
  /** Prompts only while a draft: they are the owner's to confirm or change. */
  shots: { idx: number; status: SceneMvShotRow['status']; prompt?: string }[];
  drawn: number;
  total: number;
  /** Other people's MVs being made at the same time, sharing the machine. */
  othersInProgress: number;
  failure: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/** Who may: the switch, or staff before it; and never without a video service. */
export async function assertSceneMvAllowed(ctx: AppContext, role: string | undefined): Promise<void> {
  const staff = role === 'admin' || role === 'support';
  if (!ctx.video || !((await ctx.features()).sceneMvEnabled || staff)) {
    throw new AppError('SERVICE_DISABLED', 'the AI scene MV is not available');
  }
}

function screen(text: string, what: string): void {
  const verdict = checkPrompt(text);
  if (!verdict.allowed) throw new AppError('PROMPT_BLOCKED', `the ${what} cannot be used`, { hintKey: verdict.hintKey, appealable: verdict.appealable });
}

export async function draftSceneMv(
  ctx: AppContext,
  ownerId: string,
  trackId: string,
  body: { clipStart: number; clipEnd: number; style: SceneMvStyle; description?: string | null },
): Promise<SceneMvView> {
  const track = await getTrack(trackId);
  if (!track || track.deleted_at || track.owner_id !== ownerId) throw new AppError('NOT_FOUND', 'no such song');
  if (track.state !== 'deliverable') throw new AppError('TRACK_NOT_DELIVERABLE', 'the song is not playable');
  const span = body.clipEnd - body.clipStart;
  if (!(body.clipStart >= 0) || !(span > 0) || span > MAX_SPAN_SECONDS) {
    throw new AppError('VALIDATION_FAILED', `the span must be over 0 and at most ${MAX_SPAN_SECONDS} seconds`);
  }
  if (body.clipEnd > track.duration_ms / 1000 + 0.5) throw new AppError('VALIDATION_FAILED', 'the span runs past the end of the song');
  const description = body.description?.trim() || null;
  if (description) screen(description, 'description');
  const id = await createSceneMvDraft({
    ownerId,
    trackId,
    style: body.style,
    description,
    clipStart: body.clipStart,
    clipEnd: body.clipEnd,
    timingsSha: null,
    shots: buildStoryboard(body.style, description),
  });
  return (await viewSceneMv(id, ownerId))!;
}

async function ownMv(id: string, ownerId: string) {
  const mv = await getSceneMv(id);
  if (!mv || mv.owner_id !== ownerId) throw new AppError('NOT_FOUND', 'no such scene MV');
  return mv;
}

export async function viewSceneMv(id: string, ownerId: string): Promise<SceneMvView | null> {
  const mv = await getSceneMv(id);
  if (!mv || mv.owner_id !== ownerId) return null;
  const others = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM scene_mvs WHERE status IN ('queued','generating','composing') AND id <> ?`,
    [id],
  );
  return {
    id: mv.id,
    trackId: mv.track_id,
    status: mv.status,
    style: mv.style,
    clipStart: mv.clip_start,
    clipEnd: mv.clip_end,
    shots: mv.shots.map((s) => ({ idx: s.idx, status: s.status, ...(mv.status === 'draft' ? { prompt: s.prompt } : {}) })),
    drawn: mv.shots.filter((s) => s.status === 'succeeded').length,
    total: mv.shots.length,
    othersInProgress: Number(others[0]?.n ?? 0),
    failure: mv.failure,
    expiresAt: mv.expires_at ? new Date(mv.expires_at).toISOString() : null,
    createdAt: new Date(mv.created_at).toISOString(),
  };
}

export async function editSceneMvShots(id: string, ownerId: string, shots: string[]): Promise<SceneMvView> {
  await ownMv(id, ownerId);
  for (const s of shots) screen(s, 'shot description');
  if (!(await replaceDraftShots(id, ownerId, shots.map((s) => s.trim())))) throw new AppError('CONFLICT', 'only a draft can be changed', { reason: 'not_draft' });
  return (await viewSceneMv(id, ownerId))!;
}

/**
 * The caps and what a second costs, for a paid video service; null for a free
 * one. `secondsPerShot` matters only when starting, where it prices the plan.
 */
export function sceneMvBudget(ctx: AppContext, secondsPerShot = 0): SceneMvBudget | null {
  const price = ctx.video?.pricePerSecondUsd ?? 0;
  if (!ctx.video || price <= 0) return null;
  const micros = (usd: number | undefined) => (usd === undefined ? null : Math.round(usd * 1_000_000));
  return {
    perSecondMicros: Math.round(price * 1_000_000),
    secondsPerShot,
    totalMicros: micros(ctx.config.SCENE_MV_BUDGET_USD_TOTAL),
    dailyMicros: micros(ctx.config.SCENE_MV_BUDGET_USD_DAILY ?? ctx.config.SCENE_MV_BUDGET_USD_TOTAL),
    perUserDaily: ctx.config.SCENE_MV_PER_USER_DAILY,
    siteDaily: ctx.config.SCENE_MV_SITE_DAILY,
  };
}

const BUDGET_MESSAGES = {
  budget: 'the AI scene MV budget is used up for now',
  user_daily_limit: 'you have started today’s AI scene MVs already',
  site_daily_limit: 'today’s AI scene MVs are used up',
} as const;

export async function startSceneMv(ctx: AppContext, id: string, ownerId: string): Promise<SceneMvView> {
  const mv = await ownMv(id, ownerId);
  const seconds = shotSecondsFor(mv.clip_end - mv.clip_start, mv.shots.length, ctx.video?.durations);
  const r = await queueSceneMv(id, ownerId, sceneMvBudget(ctx, seconds));
  if (!r.ok) {
    if (r.reason === 'budget' || r.reason === 'user_daily_limit' || r.reason === 'site_daily_limit') {
      throw new AppError('RATE_LIMITED', BUDGET_MESSAGES[r.reason], { reason: r.reason });
    }
    if (r.reason === 'busy') throw new AppError('CONFLICT', 'another scene MV is being made', { reason: 'busy', activeId: await activeSceneMvFor(ownerId) });
    if (r.reason === 'not_draft') throw new AppError('CONFLICT', 'this scene MV has already started', { reason: 'not_draft' });
    throw new AppError('NOT_FOUND', 'no such scene MV');
  }
  return (await viewSceneMv(id, ownerId))!;
}

export async function cancelOwnSceneMv(ctx: AppContext, id: string, ownerId: string): Promise<SceneMvView> {
  await ownMv(id, ownerId);
  if (!(await cancelSceneMv(id, ownerId))) throw new AppError('CONFLICT', 'this scene MV has already finished', { reason: 'finished' });
  // A shot still waiting in the service's queue is taken out of it; one already on the GPU finishes there.
  await discardAtService(ctx.video, [id]);
  return (await viewSceneMv(id, ownerId))!;
}

export async function downloadSceneMv(ctx: AppContext, id: string, ownerId: string): Promise<{ url: string; expiresAt: string }> {
  const mv = await ownMv(id, ownerId);
  if (mv.status !== 'ready' || !mv.output_key) throw new AppError('CONFLICT', 'this scene MV is not ready', { reason: 'not_ready' });
  const signed = await ctx.storage.signedUrl({ zone: 'delivery', key: mv.output_key, ttlSeconds: 600, filename: 'yuha-scene-mv.mp4' });
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}
