/**
 * The video clip contract (docs/AI_SCENE_MV_TICKETS.md, T3).
 *
 * One clip is one short, silent shot of a scene MV. YUHA asks for the shots
 * one at a time, keeps the bytes in its own storage and cuts them to the song
 * itself; nothing behind this seam sees a song, its lyrics or its owner.
 *
 * Every outcome is a value, never a throw, except `fetchClip`: a clip that
 * cannot be fetched has no bytes to return, and the caller must not mistake
 * that for an empty one.
 */
export interface ClipRequest {
  /** What the shot shows. Never logged by the provider, nor kept past the job. */
  prompt: string;
  negativePrompt?: string;
  /** Multiples of 32; the longest edge at most 1280. */
  width: number;
  height: number;
  /** At most 10. */
  seconds: number;
  fps?: number;
  seed?: number;
  /** The same key and the same request is the same clip; the same key for another request is refused. */
  idempotencyKey: string;
}

export type ClipRejection =
  | 'queue_full' // retryable: the service is busy
  | 'unavailable' // retryable: the service could not be reached, or failed
  | 'invalid_request'
  | 'idempotency_key_reused'
  | 'unauthorized';

export type ClipSubmit =
  | { status: 'accepted'; id: string }
  | { status: 'rejected'; reason: ClipRejection; retryable: boolean; detail?: string };

export type ClipState =
  | { status: 'queued' | 'running'; queuePosition: number | null }
  | { status: 'succeeded'; clipSeconds: number; generationSeconds: number | null; model: string | null }
  | { status: 'failed'; reason: string }
  | { status: 'cancelled' }
  /** Not known to the service (never made, or swept), or the service could not be asked. */
  | { status: 'unknown'; reason: 'not_found' | 'unreachable' | 'unauthorized' };

export interface VideoProvider {
  readonly kind: string;
  submit(req: ClipRequest): Promise<ClipSubmit>;
  status(id: string): Promise<ClipState>;
  /** Asks for a cancel; the clip may still take a moment to stop. Read `status` for the outcome. */
  cancel(id: string): Promise<void>;
  /** The finished clip's bytes. Throws unless the clip succeeded and its bytes could be fetched safely. */
  fetchClip(id: string): Promise<Buffer>;
}

/** The shape rules both providers apply, so the demo refuses what the real service refuses. */
export function clipShapeProblem(req: ClipRequest): string | null {
  if (!Number.isInteger(req.width) || !Number.isInteger(req.height) || req.width % 32 || req.height % 32 || req.width < 64 || req.height < 64) {
    return 'width and height must be multiples of 32, at least 64';
  }
  if (Math.max(req.width, req.height) > 1280) return 'longest edge is at most 1280';
  if (!(req.seconds > 0) || req.seconds > 10) return 'seconds must be above 0 and at most 10';
  if (req.fps !== undefined && (!Number.isInteger(req.fps) || req.fps < 8 || req.fps > 30)) return 'fps must be 8–30';
  if (!req.prompt.trim() || req.prompt.length > 1500) return 'prompt must be 1–1500 characters';
  return null;
}
