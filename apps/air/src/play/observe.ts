/**
 * The moderator's numbers for the usability test (#35), for one page load.
 *
 * Only with #observe in the address does the page show them, behind a small
 * button the participant is unlikely to notice. Nothing is stored or sent;
 * closing the tab forgets it. Times are in the page's own clock
 * (performance.now()), so they are differences, not dates.
 */
export function createObservation(shownAt: number) {
  let firstTouch: number | null = null;
  let performances = 0;
  let tooShort = 0;
  let playedMs = 0;
  let replays = 0;
  let toSongAt: number | null = null;
  let shares = 0;

  const summary = () => ({
    msToFirstTouch: firstTouch === null ? null : firstTouch - shownAt,
    performances,
    tooShort,
    playedMs,
    replays,
    toSongAtMs: toSongAt === null ? null : toSongAt - shownAt,
    shares,
  });
  const s1 = (ms: number) => (ms / 1000).toFixed(1);

  return {
    touch(at: number) {
      firstTouch ??= at;
    },
    performanceEnded(lengthMs: number) {
      performances += 1;
      playedMs += lengthMs;
    },
    tooShort(lengthMs: number) {
      tooShort += 1;
      playedMs += lengthMs;
    },
    replay() {
      replays += 1;
    },
    toSong(at: number) {
      toSongAt ??= at;
    },
    share() {
      shares += 1;
    },
    summary,
    /** One line to copy into the observation sheet. */
    line() {
      const s = summary();
      return [
        `first touch ${s.msToFirstTouch === null ? '—' : `${s1(s.msToFirstTouch)} s`}`,
        `played ${s1(s.playedMs)} s in ${s.performances} performance(s) (+${s.tooShort} too short)`,
        `replays ${s.replays}`,
        `make-it-a-song ${s.toSongAtMs === null ? 'not tapped' : `at ${s1(s.toSongAtMs)} s`}`,
        `shares ${s.shares}`,
      ].join(' · ');
    },
  };
}
