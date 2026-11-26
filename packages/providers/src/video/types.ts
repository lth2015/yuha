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
  | 'unauthorized';

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

export const CLIP_MAX_SECONDS = 8;

/** The rules both providers apply, so the demo refuses what the real service refuses. */
export function clipRequestProblem(req: ClipRequest): string | null {
  if (!(req.seconds >= 1) || req.seconds > CLIP_MAX_SECONDS) return `seconds must be 1–${CLIP_MAX_SECONDS}`;
  if (req.orientation !== 'portrait' && req.orientation !== 'landscape') return 'orientation must be portrait or landscape';
  if (!req.prompt.trim() || req.prompt.length > 1500) return 'prompt must be 1–1500 characters';
  return null;
}
