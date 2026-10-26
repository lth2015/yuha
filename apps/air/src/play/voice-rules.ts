/**
 * Rules that shape a voice once the engine has decided a note: how a plucked
 * tremolo (轮指) re-strikes it, and how long it rings after. Fixed rules, not
 * chance, so a replay or a shared link plays them identically; pure, so they
 * are tested (tests/air-voice.test.ts) rather than only heard.
 *
 * They follow the 春江花月夜 brief (docs/AIR_CHUNJIANG_PROPOSAL.md): low notes
 * ring long, and the tremolo grows quicker and starts on shorter notes as the
 * hand rises and the sound brightens.
 */

/** Each pair is [at brightness 0, at brightness 1]. */
export type TremoloRule = {
  /** Strikes a second. */
  rate: readonly [number, number];
  /** Notes shorter than this are not re-struck (fast playing would turn to mush). */
  minMs: readonly [number, number];
  /** At most this many strikes per note, the first included. */
  max: number;
  /** Each re-strike is this much softer than the one before. */
  fade: number;
};

const lerp = ([a, b]: readonly [number, number], t: number) => a + (b - a) * Math.min(1, Math.max(0, t));

/** The re-strikes after the first, as offsets into the note. */
export function tremoloStrikes(
  rule: TremoloRule,
  note: { duration: number; brightness: number; velocity: number },
): { atMs: number; velocity: number; durationMs: number }[] {
  if (note.duration < lerp(rule.minMs, note.brightness)) return [];
  const rate = lerp(rule.rate, note.brightness);
  const count = Math.min(rule.max, Math.floor((note.duration / 1000) * rate));
  const out = [];
  for (let k = 1; k < count; k += 1) {
    const atMs = (k * 1000) / rate;
    out.push({ atMs, velocity: note.velocity * 0.55 * rule.fade ** k, durationMs: note.duration - atMs });
  }
  return out;
}

/** Release time constant in seconds: `lowTail` adds that fraction again at brightness 0. */
export const releaseFor = (base: number, lowTail: number, brightness: number) =>
  lowTail ? base * (1 + lowTail * (1 - Math.min(1, Math.max(0, brightness)))) : base;
