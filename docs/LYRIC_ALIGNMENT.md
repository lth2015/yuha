# Lyric alignment

Synced lyrics on a song page come from one of three places, and the pill above
them says which:

| `source` | Where it comes from | Pill |
| --- | --- | --- |
| `aligned` | The aligner on the DGX heard the song (`POST /v1/align`, `deploy/dgx/music/server/align.py`) | 已对齐 / aligned |
| `corrected` | A timing saved with the former manual editor | 已校正 / corrected |
| `estimated` | Nothing heard it; lines are laid across the song by length (`apps/web/src/lib/lyrics.ts`) | 估算同步 / estimated |

A new song is aligned once, by the worker, right after delivery
(`apps/worker/src/pipeline.ts`). If the aligner is down or hears too little of
the lyrics, the song keeps the estimate, and the worker logs
`lyric alignment fell back to an estimate` with the reason. The reason is one
of `aligner_timeout`, `aligner_http_422 low_coverage coverage=0.62` or
`aligner_threw: …`. Before 2026-10-29 that reason was discarded, so an
estimated song left no trace of why.

Since 2026-11-25 the reason is also kept with the song, as `fallbackReason`
inside `tracks.lyric_timings`, because the log is kept 15 days and customers
report a song weeks after they made it. No client ever receives it
(`clientTimings` in `packages/db/src/tracks.ts` strips it from every view), and
a person's correction replaces the whole timeline, reason included.

## Automatic sync of new songs (`LYRIC_AUTO_SYNC`)

L4a in [AUTOMATIC_LYRIC_SYNC_TICKETS.md](AUTOMATIC_LYRIC_SYNC_TICKETS.md). With `LYRIC_AUTO_SYNC` set
to `staff` (staff members' songs) or `all`, a new sung song is **not** aligned during delivery:

1. Delivery queues one `lyric_sync_jobs` row per song, master audio and lyrics. The unique key
   means a retried delivery, a refresh or a second tab never makes a second job. The song is
   playable straight away. `lyricSync` is `syncing`, and the lyrics show as static text.
2. The worker (`apps/worker/src/lyric-sync.ts`) claims a due job and asks the aligner, using the
   DGX's own copy of the render while it still has one and otherwise the song's master.
3. If the aligner heard the song, the timeline is **applied** through the guarded write
   (`storeDeliveredLyricTimings` with `masterSha`). That write is refused when the song was
   deleted or corrected, its words changed, or its master is another file; the job then ends
   `kept`.
4. A failure, or an estimate the aligner fell back to, is retried after 1, 5 and 30 minutes.
   After the fourth attempt the job is `failed`: the song keeps a labelled estimate, `lyricSync`
   is `unavailable`, and the song counts as **not synced**.
5. A claim older than 10 minutes (a pod roll) is taken back, and that attempt counts.

`lyricSync` in the track view is `synced` for a heard or corrected timeline, `partial` when a
heard line's `confidence` is below 0.5, `syncing` while a job is queued or running, and
`unavailable` otherwise. It is `null` for a song with nothing sung.

`off` (the default) is the previous behaviour, so rolling back is one value.

## Which aligner (`LYRIC_ALIGNER`)

`off` / `staff` / `all`, decided by who owns the song. When it applies, YUHA's request to the DGX
carries `method: qwen`: Qwen3-ForcedAligner fused with Whisper, with per-line confidence
(deploy/dgx/music README, "Qwen3-ForcedAligner"). Otherwise the DGX uses its own default, Whisper
on the vocal stem. It is read wherever YUHA aligns: delivery, the automatic sync queue, and
re-alignment proposals. Production has `all`, paired with `LYRIC_STRICT_TIMELINE=all` so that an
unsure line is lit for nobody (product owner, 2026-11-27).

## Backfill of older songs (`LYRIC_BACKFILL`)

This is L4b. With `LYRIC_BACKFILL` set to `staff` or `all`, an older sung song with no heard
timeline (none, or an estimate) is queued for a sync **when its owner opens it**. Only the owner's
`GET /v1/tracks/:id` does this. The library list and visitors on a shared link never do.

- **Audio.** It always sends YUHA's own master (`audio_b64`). An old song may still name a DGX
  render the DGX cleared long ago. The aligner must therefore take sent audio, so turn this on
  only after `deploy/dgx/update.sh` and one real `audio_b64` request.
- **Quota.** At most `LYRIC_BACKFILL_DAILY` jobs per JST day (default 30). Past that, the song
  plays with its words, `lyricSync` is `deferred` (「今天暂时无法同步，下次打开会自动再试」), and the
  song is queued the next time it is opened. Tabs share one job: it is one job per song,
  master and words.
- **Failures.** A failure from an earlier day is tried again on the next open; a failure from today
  is not.
- **Queue order.** New songs' syncs are claimed first.
- **The page.** While `syncing`, the song page asks again every 12 s, only while it is in front,
  and swaps in only the timeline. The music keeps playing, the highlight picks up at the current
  position, and the video card reads the same timings. While syncing with no timeline, the words
  show with no line lit.

## Diagnosing a song whose words do not match the voice

**Across all songs**: admin console → 运营指标 → 生成质量. 「歌词对齐（人声）」 is the
share of sung songs with `aligned` or `corrected` timing. The line under the
table, 「歌词未对齐的原因（近 7 天）」, counts the rest by the first word of the reason:

| Reason | Means | Look at |
| --- | --- | --- |
| `deleted` | The song was deleted after it was made; its words went with it. | Nothing. |
| `no_lyrics` | Sung with no words: in simple mode the text model wrote none, or they failed screening and the song was sung wordless. Nothing to align, nothing shown. | The text model, not the aligner. Many of these is a lyric-writing problem. |
| `no_timing` | There were words, and nothing could be stored: the aligner failed and the estimator did too, or storing failed. | Worker log, `lyric alignment failed`. |
| `not_recorded` | An estimate with no reason: a song made before 2026-11-25, or `ALIGNMENT_ADAPTER` is `estimated` (unset), so the aligner was never asked. | If new songs keep landing here, the deployment's alignment settings. |
| `aligner_timeout` | The DGX did not answer within `ALIGNMENT_TIMEOUT_MS` (180 s in `03_wire_yuha.sh`). | DGX load: alignment waits behind song renders on the same GPU. |
| `aligner_http_4xx` / `5xx` | The DGX answered and refused. `422 … coverage=0.31` is "heard too little of the lyrics". | The song itself, then `ALIGN_FORCED_MIN_COVERAGE`. |
| `aligner_threw` | The request did not complete (connection refused, DNS, TLS). | Whether the DGX is reachable from the worker. |
| `aligner_no_lines` / `aligner_bad_line` / `aligner_lyrics_mismatch` | The DGX answered 200 with something the app cannot use: no lines, a malformed line, or lines that are not these lyrics. | The DGX's response format (`ALIGNMENT_*_FIELD`), then the aligner itself. |
| `other` | Everything past the eighth reason, summed, so the counts add up to the misses. | The worker log for the rare ones. |
| `no_audio_url` | `ALIGNMENT_AUDIO_URL_TEMPLATE` is not set, so the aligner cannot fetch the song. | The deployment's alignment settings. |

**One song**: its `tracks.lyric_timings` has `source`, `aligner` and, for an
estimate made since 2026-11-25, `fallbackReason`:

```sql
SELECT JSON_UNQUOTE(JSON_EXTRACT(lyric_timings, '$.source')) AS source,
       JSON_UNQUOTE(JSON_EXTRACT(lyric_timings, '$.aligner')) AS aligner,
       JSON_UNQUOTE(JSON_EXTRACT(lyric_timings, '$.fallbackReason')) AS why
  FROM tracks WHERE id = ?;
```

`aligned` with lines in the wrong place is a different problem from an
estimate: the aligner heard something and placed it wrongly, which is a sample
for the DGX side (`deploy/dgx/music/README.md`), not a configuration fault.
Where the retry feature is available, the owner can ask YUHA to listen again
without remaking the song.

The DGX keeps a render for six days (`RETENTION_DAYS`). A song older than that
cannot be re-aligned, because the aligner fetches the audio from the DGX
(`ALIGNMENT_AUDIO_URL_TEMPLATE`), and the run below leaves it as it was.

## Aligning one song again (the owner's button)

In the song page's lyrics section, the signed-in owner can press “Retry lyric sync”.
`POST /v1/tracks/:id/lyric-proposal` queues it and `GET` reads it
(`services/lyric-proposal.ts`, migration 0035).

- **The song itself goes to the aligner** (`audio_b64`), not a link to the
  DGX's copy, so a song of any age can be aligned: the DGX keeps renders
  six days, YUHA keeps every song.
- **The answer stays available when the owner returns.** “Use new lyric sync”
  applies the latest matching result by proposal ID. Only the stored server
  result can be applied. It remains labelled `aligned`, with its original
  line confidence. A historical `corrected` timeline is preserved.
- **Only what the aligner heard is offered.** An estimate is reported as a
  failure — `low_coverage` (heard too little), `timeout`, `unreachable` or
  `error` — and the page says so in words; the song keeps its timing.
- **Free, and bounded.** No credit. Three requests per song per day; asking
  again while one waits returns that one. One at a time per API process,
  because each is a GPU job on the box that renders customers' songs; a
  request left running by a stopped process is reported `interrupted` after
  15 minutes.
- **Words changed meanwhile** (`lyrics_changed`): an answer for words the song
  no longer has is not offered.
- **The proposal holds lines of the lyrics**, so it is deleted with the song's
  words (account deletion, an unclaimed trial's expiry) and by the cascade.
- **Off until the DGX takes sent audio.** `FEATURE_LYRIC_AUTO_ALIGN_ENABLED`
  (default off, `"false"` in `deploy/k8s/qa/resources.yaml`). Turn it on only
  after `deploy/dgx/update.sh` and the check in `deploy/dgx/music/README.md`
  ("The song itself, sent"). It can be switched off at runtime like the other
  features (`feature_overrides` → `lyricAutoAlignEnabled: false`). The button
  is also hidden wherever the only aligner is the estimator.

## How the aligner listens

`deploy/dgx/music/README.md` → "Lyric alignment" has the detail. In short,
Demucs separates the vocal first. Then:

1. **Forced alignment (`ALIGN_METHOD=forced`, the default since 2026-10-29,
   `forced.py`).** The known lyrics are romanised:
   - Japanese with fugashi + cutlet;
   - Chinese with pypinyin;
   - Korean with hangul-romanize.

   torchaudio's MMS_FA CTC model then places every unit on the stem by
   Viterbi. A digit, an acronym sung letter by letter (JPYC), or anything
   else without letters becomes a star token that matches any sound. A star
   also opens every line, to absorb breaths and ad-libs.

   Its coverage is the share of lettered units found with a mean frame
   posterior ≥ 0.05. If that is at least `ALIGN_FORCED_MIN_COVERAGE` (0.6),
   the result is used.
2. **Whisper (the fallback, and the whole path under
   `ALIGN_METHOD=whisper`).** Whisper transcribes the vocal stem, the known
   lyrics are matched onto its words character by character, and the stem's
   loudness corrects line starts and ends that Whisper smeared across an
   instrumental. It is gated by `ALIGN_MIN_COVERAGE` (0.85).

Why forced is first: Whisper's word times are a by-product of recognition,
and a sung word it did not recognise had no time at all. Such lines were
spread by character count between their neighbours, which is the "some
lines early, some late" people noticed. A song Whisper covered less than
85% of was given up on and shown as 估算同步. Forced alignment answers only
"where is each known unit sung", and answers it for every unit.

The aligner runs on the DGX, so it is updated by `deploy/dgx/update.sh`, not
by a merge. The first forced alignment after an update downloads the MMS_FA
weights (about 1.2 GB) into the mounted `~/.cache/torch`.

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
