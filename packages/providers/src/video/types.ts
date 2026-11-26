/**
 * The video clip contract (docs/AI_SCENE_MV_TICKETS.md, T3).
 *
 * One clip is one short, silent shot of a scene MV. YUHA asks for the shots
 * one at a time, keeps the bytes in its own storage and cuts them to the song
 * itself; nothing behind this seam sees a song, its lyrics or its owner.
 *
 * Shaped by the service actually running on dgxv (the model service's API
 * note, 2026-11-26): a clip is a duration and an orientation — the service
 * decides the frame size — and it has no idempotency key. So:
 *   - `discard` cancels a clip still queued and deletes a finished one; a
 *     shot already on the GPU finishes there, at the platform's cost
 *     (docs/AI_SCENE_MV_SPEC.md allows this);
 *   - a submit that timed out may still have been accepted; the caller must
 *     not resubmit blindly (the pipeline records ids as soon as it has them).
 *
 * Every outcome is a value, never a throw, except `fetchClip`: a clip that
 * cannot be fetched has no bytes to return, and the caller must not mistake
 * that for an empty one.
 */
export type ClipOrientation = 'portrait' | 'landscape';

export interface ClipRequest {
  /** What the shot shows. Never logged by YUHA. */
  prompt: string;
  /** 1–8 seconds. */
  seconds: number;
  orientation: ClipOrientation;
}

export type ClipRejection =
  | 'queue_full' // retryable: the service is busy
  | 'unavailable' // retryable: could not be reached, timed out, or failed
  | 'invalid_request'
  | 'unauthorized'
  /**
   * The submit may or may not have been accepted (it timed out, or the
   * connection broke after the request was sent). It may be running, and
   * billed: never resubmitted automatically (docs/AI_SCENE_MV_VEO_SPEC.md §3).
   */
  | 'uncertain';

export type ClipSubmit =
  | { status: 'accepted'; id: string }
  | { status: 'rejected'; reason: ClipRejection; retryable: boolean; detail?: string };

export type ClipState =
  | { status: 'queued' | 'running'; queuePosition: number | null }
  | { status: 'succeeded' }
  | { status: 'failed'; reason: string }
  /** Not known to the service (never made, or swept), or the service could not be asked. */
  | { status: 'unknown'; reason: 'not_found' | 'unreachable' | 'unauthorized' };

export interface VideoProvider {
  readonly kind: string;
  /** The clip lengths it draws, when it only draws some (Veo: 4, 6, 8); any 1–8 otherwise. */
  readonly durations?: readonly number[];
  /** US dollars per second of video drawn, as published; absent or 0 for a free service (the demo, our own server). */
  readonly pricePerSecondUsd?: number;
  submit(req: ClipRequest): Promise<ClipSubmit>;
  status(id: string): Promise<ClipState>;
  /** The finished clip's bytes. Throws unless the clip succeeded and its bytes could be fetched safely. */
  fetchClip(id: string): Promise<Buffer>;
  /**
   * Lets go of a clip: cancels it while it is still queued, deletes it once
   * finished. Best effort — a clip already on the GPU cannot be stopped, and
   * the service keeps finished clips seven days anyway.
   */
  discard(id: string): Promise<void>;
  /** Whether the service answers, and how many clips it has waiting when it says. Never throws. */
  health(): Promise<{ ok: boolean; queued: number | null }>;
}

const CLIP_MAX_SECONDS = 8;

/** The rules both providers apply, so the demo refuses what the real service refuses. */
export function clipRequestProblem(req: ClipRequest): string | null {
  if (!(req.seconds >= 1) || req.seconds > CLIP_MAX_SECONDS) return `seconds must be 1–${CLIP_MAX_SECONDS}`;
  if (req.orientation !== 'portrait' && req.orientation !== 'landscape') return 'orientation must be portrait or landscape';
  if (!req.prompt.trim() || req.prompt.length > 1500) return 'prompt must be 1–1500 characters';
  return null;
}

/**
 * How long each shot is: the span shared out, at most what a clip can be,
 * and — for a service that draws only some lengths (Veo: 4/6/8) — the shortest
 * of those that covers it, since a clip is billed by the second.
 */
export function shotSecondsFor(span: number, shots: number, durations?: readonly number[]): number {
  const need = Math.max(1, Math.min(CLIP_MAX_SECONDS, Math.ceil(span / Math.max(1, shots))));
  if (!durations?.length) return need;
  return [...durations].sort((a, b) => a - b).find((d) => d >= need) ?? Math.max(...durations);
}
