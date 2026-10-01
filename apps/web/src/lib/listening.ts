/**
 * What counts as having listened to a song.
 *
 * The activation metric asks whether somebody heard ten seconds of a
 * generated song. The player used to answer it with `audio.currentTime >= 10`,
 * under a comment saying it counted "real listening, not a click on play" — it
 * did not. The player bar has a scrubber, and dragging it past the ten-second
 * mark satisfied that test instantly, so a drag would have been recorded as a
 * listen. A metric nobody can trust is worse than no metric: it still gets
 * quoted.
 *
 * The rule lives here, outside React, because it is the part worth pinning.
 */

/** A song's accumulated listening, carried between `timeupdate` ticks. */
export interface Heard {
  /** The song this total belongs to; a different id starts over. */
  id: string | null;
  /** Seconds of audio actually played, not the playhead's position. */
  seconds: number;
  /** Where the playhead was at the previous tick. */
  last: number;
}

export const HEARD_SECONDS_FOR_PREVIEW = 10;

/**
 * The largest jump that can be one tick of playback.
 *
 * `timeupdate` fires about every 250ms while playing. Anything beyond a second
 * is a seek, a stall catching up, or a background tab being throttled and then
 * resuming — none of which is a person listening. A backwards jump is a seek
 * too. Both move the mark without crediting the time.
 */
export const MAX_TICK_SECONDS = 1;

export function creditHeard(prev: Heard, id: string, currentTime: number): Heard {
  if (prev.id !== id) return { id, seconds: 0, last: currentTime };
  const delta = currentTime - prev.last;
  const credited = delta > 0 && delta <= MAX_TICK_SECONDS ? delta : 0;
  return { id, seconds: prev.seconds + credited, last: currentTime };
}

export function hasHeardEnough(heard: Heard): boolean {
  return heard.seconds >= HEARD_SECONDS_FOR_PREVIEW;
}
