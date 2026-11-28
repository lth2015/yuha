# Lyric sync benchmark

Batch 2 of [NEXT_ITERATION_MUSIC_FIRST.md](../NEXT_ITERATION_MUSIC_FIRST.md): one fixed set of
zh / ja / en songs, heard by people, against which every alignment route is
scored the same way. Method from [LYRIC_SYNC_REVIEW_CLAUDE.md](../LYRIC_SYNC_REVIEW_CLAUDE.md) §4.

```bash
pnpm --filter @yuha/contracts build
node scripts/lyric-bench.mjs                       # quality-probes/lyric-bench (gitignored)
node scripts/lyric-bench.mjs <dir> --base current --tolerance 0.3 --confident 0.5
```

The scorer is tested against hand-made annotations with known answers:
`tests/lyric-bench.test.ts`.

## Files

Everything lives under a gitignored directory. The audio and lyrics are songs; they stay out of
this public repository.

```
<dir>/annotations/<annotator>/<songId>.json
<dir>/routes/<route>/<songId>.json
```

**Annotation** (one person, one song, written while listening and without looking at any route's
output):

```json
{ "songId": "s01", "language": "ja",
  "lines": [ { "idx": 0, "sung": true, "start": 12.4 },
             { "idx": 1, "sung": false, "start": null } ] }
```

There is one entry per lyric line, in the song's line order. `sung: false` means the line is
never sung: it was dropped, changed beyond recognition, or replaced by an ad-lib. `start` is
the second at which the line is first sung.

**Route prediction:** the song's `lyricTimings`, as `GET /v1/tracks/:id` returns it. It must
have the same line count as the song. The scorer refuses anything else rather than guess an
alignment between the two.

## What is counted

| Measure | Definition |
| --- | --- |
| line hit | A sung line eligible for strict playback whose start is within ±tolerance |
| unconfirmed | A line excluded by the shared eligibility rules. These exclude estimates, low confidence for aligned lines, stacked aligned starts and zero-duration lines |
| falsely lit | An unsung line that the route would light up as sung. **Any increase rejects a route**, whatever its hit rate |
| usable with no edits | A song where every sung line is a hit and no unsung line is lit: you can listen to it without anyone touching it |
| noise floor | The median and P90 of the start differences between two annotators. The tolerance must not be below that P90 |

Intervals are 95% intervals from a bootstrap clustered by song (seeded, so they are
reproducible). Two routes are compared line by line, and the result is reported as `better` or
`worse` only when the interval of the paired difference excludes 0.

## Sample

The sample follows the review: 18 songs, 6 per language, with 6 held out for the decision
run. The songs need to cover a repeated chorus, an interlude, a dropped line and a changed
word. The first run scores the current production path (`routes/current`), and it is the
baseline that the absolute targets are agreed on.

## Ground truth from staff songs, and the aligners on the DGX (2026-11-27)

1. **Make staff songs and annotate offline.** Use the [staff guide](LYRIC_TRUTH_GUIDE.md)
   and the annotation format above. The DGX retains renders for six days, so align there
   within that window. Keep the sample manifest and annotations in the gitignored directory.
2. **Previously annotated staff songs** can still be exported using `pnpm bench:lyric-truth quality-probes/lyric-bench`
   on the production read-only connection. Use a separate empty directory when combining
   older exports with new annotations, then copy the relevant files. The exporter queries
   staff songs only and refuses to write when there is no stored correction.
3. **Align on the DGX.** Copy the folder to `~/yuha-bench/truth`, then run
   `bench_align.py --truth /bench/truth` (the command is in `deploy/dgx/music/README.md`). It
   writes `routes/whisper/` and `routes/qwen/` beside the annotations.
4. **Score** from a checkout with dependencies installed. Run `pnpm --filter @yuha/contracts build` and then `node scripts/lyric-bench.mjs quality-probes/lyric-bench --base whisper`.

There are two limits to keep in mind:

- A correction made with the former editor starts from the timeline the song already had. People tend to accept a start that
  is close enough, so the truth leans towards whichever route made the first timeline. Correct
  every line by listening, not only the ones that look wrong.
- The legacy exporter cannot tell when a line was never sung. Every exported line is `sung: true`, so
  "falsely lit" is not measured this way.
- For the false-highlight check, independently listen to dedicated test audio and set each
  confirmed omitted line to `sung: false` with `start: null`. Include a repeated chorus and
  a long instrumental gap. The strict player and captions clear the gap, and LRC writes
  an empty timestamp at the preceding line's end when the next timestamp leaves room for one.
- The scores compare eligible lines and their start times. The score does not resolve
  which line is visible at each instant if two otherwise eligible timings overlap.
