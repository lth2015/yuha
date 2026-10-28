# Lyric alignment

Synced lyrics on a song page come from one of three places, and the pill above
them says which:

| `source` | Where it comes from | Pill |
| --- | --- | --- |
| `aligned` | The aligner on the DGX heard the song (`POST /v1/align`, `deploy/dgx/music/server/align.py`) | 已对齐 / aligned |
| `corrected` | The song's owner fixed the timing by hand on the song page | 已校正 / corrected |
| `estimated` | Nothing heard it; lines are laid across the song by length (`apps/web/src/lib/lyrics.ts`) | 估算同步 / estimated |

A new song is aligned once, by the worker, right after delivery
(`apps/worker/src/pipeline.ts`). If the aligner is down or hears too little of
the lyrics (`ALIGN_MIN_COVERAGE`), the song keeps the estimate.

## How the aligner listens

`deploy/dgx/music/README.md` → "Lyric alignment" has the detail. In short:
Demucs separates the vocal, Whisper transcribes the vocal stem, the known
lyrics are matched onto Whisper's words character by character, and the
stem's loudness corrects line starts and ends that Whisper smeared across an
instrumental. The aligner runs on the DGX, so it is updated by
`deploy/dgx/update.sh`, not by a merge.

## Re-aligning songs made before an improvement

Admin console → 运营 → **重新对齐歌词** (`/v1/admin/lyric-realignments`,
admin only, reason required, audited as `lyric_realign.started` /
`lyric_realign.finished`).

A run walks every sung song with lyrics, oldest id first, and asks the
aligner again. What it may change is narrow on purpose:

- **Rewritten only when the aligner heard it.** The answer must be `aligned`.
  When the aligner could not — the render is no longer on the DGX, coverage
  was too low, the box was down — the song keeps the timing it had. An
  estimate never replaces anything.
- **A person's correction is never touched**, including one saved while the
  aligner was working on that song: the song is re-read under lock before it
  is written.
- **One song at a time.** Each one is a GPU job on the box that renders
  customers' songs and waits its turn behind them. A run over many songs
  takes hours; the console polls it.
- **Interrupted, it continues.** The run records the last song it finished
  (`lyric_realignments.cursor_track_id`, migration 0025). If the API pod
  restarts, the card says the run stopped and offers 继续, which carries on
  after that song. Only one run can be unfinished at a time.

Run it after `update.sh` has shipped an aligner change, not before: a run
against the old aligner only re-creates the timings songs already have.
