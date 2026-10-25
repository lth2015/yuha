/**
 * One moment of a gesture, whatever produced it.
 *
 * This shape is the contract shared, as a document and not as code, with the
 * Wonderful World project (docs/AIR_WONDERFUL_WORLD_SYNC.md). Changing a field
 * or what a value means is proposed and agreed on both sides first.
 */
export type GestureFrame = {
  /** Milliseconds, increasing, from the start of this performance. */
  t: number;
  /** Whether a finger or hand is "down". */
  active: boolean;
  /** 0..1, left to right. */
  x: number;
  /** 0..1, bottom to top: raising the hand makes it larger. */
  y: number;
  /** 0..1, smoothed and normalised movement speed. */
  speed: number;
  /** 0..1, how "open" the gesture is. */
  openness: number;
  /** 0..1, distance between two points (fingers or hands); null with one. */
  spread: number | null;
  /** 0..1; always 1 for touch, recognition confidence for a camera. */
  confidence: number;
  source: 'touch' | 'pointer' | 'camera';
};
