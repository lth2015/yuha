/**
 * Lengths, in the unit everything else here uses.
 *
 * The contract measures text in Unicode code points (`[...v].length`), the
 * counters beside the fields print code points, and the safety screen refuses
 * on code points. The DOM's `maxLength` does not: it is defined over UTF-16
 * code units, so one astral character — any emoji — spends two of its budget
 * and one of everyone else's.
 *
 * That was not theoretical. A title of emoji stopped accepting input at 60
 * while the counter beside it read "60 / 120" and the server would have taken
 * all 120: the reader stopped half way by a number promising twice as much.
 *
 * So the cap is applied here instead, on the value, in the same unit as the
 * counter and the contract. scripts/check-codepoint-limits.mjs refuses a
 * `maxLength` set from a code-point limit so the two cannot drift back apart.
 */

/** How long a string is in the unit the contracts and the counters use. */
export function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * Cut to `max` code points, never through the middle of one.
 *
 * `slice` on the string would count UTF-16 units and could split a surrogate
 * pair, which renders as a replacement character — a field that corrupts what
 * was typed into it is worse than one that accepts too much.
 */
export function clampToCodePoints(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : points.slice(0, max).join('');
}
