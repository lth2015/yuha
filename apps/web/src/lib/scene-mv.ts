import type { LyricTimings, RuntimeInfo } from '@yuha/contracts';
import { apiFetch } from './api';

/** T7 boundary, kept local while Claude implements the API on its own branch. */
export type SceneStyle = 'neon_rain' | 'seaside_sunset' | 'soft_watercolor';
export type SceneStatus = 'draft' | 'queued' | 'generating' | 'composing' | 'ready' | 'failed' | 'cancelled';
export interface SceneMvJob {
  id: string;
  trackId: string;
  status: SceneStatus;
  style: SceneStyle;
  clipStart: number;
  clipEnd: number;
  shots: Array<{ idx: number; prompt?: string; status?: string }>;
  drawn?: number;
  total?: number;
  aheadOfYou?: number;
  failure?: string | null;
  expiresAt?: string | null;
  createdAt?: string;
  /** Current T7 reports active work, not a FIFO queue position. */
  othersInProgress?: number;
}
export interface SceneMvInput {
  clipStart: number;
  clipEnd: number;
  style: SceneStyle;
  description?: string;
}
export interface SceneMvClient {
  list(trackId: string, signal?: AbortSignal): Promise<SceneMvJob[]>;
  get(id: string, signal?: AbortSignal): Promise<SceneMvJob>;
  create(trackId: string, input: SceneMvInput): Promise<SceneMvJob>;
  patch(id: string, shots: string[]): Promise<unknown>;
  start(id: string): Promise<unknown>;
  cancel(id: string): Promise<unknown>;
  download(id: string, signal?: AbortSignal): Promise<{ url: string; expiresAt: string }>;
  remove(id: string): Promise<unknown>;
}
export const SCENE_STYLES: readonly SceneStyle[] = ['neon_rain', 'seaside_sunset', 'soft_watercolor'];
export const sceneActive = (s: SceneStatus) => s === 'queued' || s === 'generating' || s === 'composing';

export function sceneMvAvailable(runtime: RuntimeInfo | null): boolean {
  return (
    (runtime?.features as (RuntimeInfo['features'] & { sceneMv?: boolean }) | undefined)?.sceneMv === true
  );
}

export function defaultSceneClip(
  duration: number,
  timings?: LyricTimings | null,
): { clipStart: number; clipEnd: number } {
  const end = Number.isFinite(duration) ? Math.max(0, duration) : 0;
  const length = Math.min(30, end);
  const chorus = timings?.lines.find((l) => /chorus|hook|refrain|副歌|高潮|サビ/i.test(l.section ?? ''));
  const start = Math.max(0, Math.min(chorus?.start ?? (end - length) / 2, end - length));
  return { clipStart: Number(start.toFixed(1)), clipEnd: Number(Math.min(end, start + length).toFixed(1)) };
}

/** Do not display a misleading empty state when an API response is malformed. */
export function normalizeSceneList(value: unknown): SceneMvJob[] {
  const items = Array.isArray(value) ? value : (value as { items?: unknown } | null)?.items;
  if (
    !Array.isArray(items) ||
    !items.every(
      (x) =>
        x &&
        typeof x.id === 'string' &&
        ['draft', 'queued', 'generating', 'composing', 'ready', 'failed', 'cancelled'].includes(x.status),
    )
  ) {
    throw new Error('invalid scene MV list');
  }
  return items as SceneMvJob[];
}

const jobPath = (id: string) => `/v1/scene-mvs/${encodeURIComponent(id)}`;
const trackPath = (id: string) => `/v1/tracks/${encodeURIComponent(id)}/scene-mvs`;
export const sceneMvClient: SceneMvClient = {
  list: async (id, signal) => {
    const value = await apiFetch<unknown>(trackPath(id), { signal });
    return normalizeSceneList(value);
  },
  get: (id, signal) => apiFetch(jobPath(id), { signal }),
  create: async (trackId, input) => ({
    ...input,
    ...(await apiFetch<SceneMvJob>(trackPath(trackId), { method: 'POST', body: input })),
    trackId,
  }),
  patch: (id, shots) => apiFetch(jobPath(id), { method: 'PATCH', body: { shots } }),
  start: (id) => apiFetch(`${jobPath(id)}/start`, { method: 'POST' }),
  cancel: (id) => apiFetch(`${jobPath(id)}/cancel`, { method: 'POST' }),
  download: (id, signal) => apiFetch(`${jobPath(id)}/download`, { signal }),
  remove: (id) => apiFetch(jobPath(id), { method: 'DELETE' }),
};
