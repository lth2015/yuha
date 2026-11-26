# Automatic lyric sync: implementation tickets (Claude)

2026-11-26 · Claude's handoff reply to the [product plan](AUTOMATIC_LYRIC_SYNC_NEXT_PHASE.md) (`9ec0050`) · checked against master `c969ae0`.

Each ticket below can be merged, verified and released on its own. Rule for every batch: CI green → Codex cross-acceptance → `yuha.studio`, and the receipt records the PR, the deploy run, the production build SHA, the JST time, coverage and the results.

## Status now

| Ticket | PR | State |
| --- | --- | --- |
| L1 write guard | [#149](https://github.com/lth2015/yuha/pull/149) | Implementation `b6a4ce1`. CI was red for a reason outside this PR: master's `alignment-config` test fails because the config throws early. The same fix was ported in `faa745f` and CI is re-running. Merge after green and Codex acceptance |
| L2 per-line evidence (data layer) | [#150](https://github.com/lth2015/yuha/pull/150) | `forced.py` gives each line a `confidence`, and the contract adds the optional `lines[].confidence` field. It takes effect once dgxa is redeployed; YUHA is compatible before and after that |
| L3 benchmark scorer | [#151](https://github.com/lth2015/yuha/pull/151) | `scripts/lyric-bench.mjs` + `docs/quality/LYRIC_BENCH.md`. The scorer is verified with known-answer annotations. It still needs real test audio and blind annotations from two people |

### What L1 covers and what it does not

It is a single conditional `UPDATE`. A late timeline does not overwrite anything when the song is deleted, the `lyrics` have changed, the owner has saved a `corrected` timeline, or an estimate would replace an `aligned` one.
**Not yet bound to the audio version**: a track's `master` asset is unique per track (`asset_versions_variant_uk`), and no path currently replaces a delivered master, so binding to lyrics is enough today. L4 records `master_sha256` with every job and checks it again when applying, so the guard is in place before an audio edit that can replace the master ever exists.

## L2 remainder: shared rules for trusted timelines (to be done)

| Item | Implementation | Acceptance |
| --- | --- | --- |
| L2.1 Telling repeated choruses apart | Each lyric line carries its order of occurrence (the N-th appearance of the same text). The scorer and the contract compare by line index, never by text | Bench sample with a repeated chorus: lines map one to one, and a second chorus is never scored as the first |
| L2.2 One function for "can this line be highlighted?" | `trustedLine(line)` in `@yuha/contracts`. A line is trusted when its source is `corrected`, or its source is `aligned` and its `confidence` is absent (historical data) or at least the threshold. Every consumer calls only this function: the player, photo/cover video, scene MV and `.lrc` | Consumer tests: with the same timeline, the player, the three ASS outputs and the `.lrc` show/skip exactly the same set of lines |
| L2.3 Mixed old and new data | Historical `aligned` timelines without `confidence` stay trusted (as before), and `estimated` stays untrusted (static) | Old fixtures play unchanged |

How untrusted lines are shown (static text, no highlight, the 「部分歌词暂未同步」 notice) is for Codex to decide. Claude implements it from that design.

## L4a New songs: synced and applied automatically

**Data**: a new migration widens `lyric_proposals` into `lyric_sync_jobs`, or adds a table alongside it.
- New columns: `master_sha256`, `trigger` (`delivery` / `backfill` / `retry`), `attempts`, `next_attempt_at`, `applied` (0/1).
- Unique key `(track_id, master_sha256, lyrics_sha)`, so refreshing the page or opening the song on several devices never starts a second job.
- Owner IDs and lyrics stay out of the logs.

**Flow**
1. On delivery, enqueue a job in the same transaction. The synchronous alignment that currently takes up to 60 s inside the generation job is removed, so delivery no longer waits on the aligner.
2. A worker loop claims jobs. The queue moves out of the API process; today the drain runs in the background of a request, and a pod roll interrupts it.
3. If the aligner passes, the result is **applied automatically** through the guarded write: master sha + lyrics sha + no `corrected` + no downgrade.
4. Failures are retried within bounds: 3 attempts at 1, 5 and 30 minutes. After that the status is `failed` and an estimate or static lyrics remain, **counted as sync not done**.

**Client**
- The track view adds `lyricSync: 'syncing' | 'synced' | 'partial' | 'unavailable'`. Instrumental songs have none.
- While `syncing`, the page polls GET every 10–15 s and stops when it is in the background.
- When the timeline changes mid-playback, only the lyric view is swapped, never the player's clock or audio. The wording and states are Codex's.

**Switch**
- `FEATURE_LYRIC_AUTO_SYNC`: off / staff / percentage.
- Off keeps today's behaviour, where delivery waits for alignment synchronously, so rollback is a one-line config change.

**Tests**
- Deduplication: concurrent enqueues produce one job.
- Version checks: master sha changes, lyrics change, a correction is saved, the song is deleted.
- Retries and their limit.
- Pod restart recovery: stale claims are taken back.
- Delivery does not wait for alignment.
- `partial` is produced when one line has low confidence.

**Acceptance**
Codex, on phone and desktop through the normal song-page entry: first play, refresh, scrubbing to any point, two tabs open at once, export.
Production small rollout: staff first, then a percentage. Report time-to-first-play-ready and the share of plays that started already synced, per language.

**Dependency**: dgxa `/v1/align` must accept `audio_b64`. This is still waiting on the owner's DGX update. Until then the aligner can only be reached through `audio_url`, which works only for fresh renders the DGX still holds.

## L4b Older songs: controlled backfill

- **Trigger**: an owner or listener opens a sung song whose timeline is missing or `estimated`, and the switch is on. The audio is read from YUHA's own master, not from the DGX's temporary render.
- **Limits**: a daily site-wide cap (`LYRIC_BACKFILL_DAILY`) and a DGX concurrency of 1 on the same queue. New songs go first, backfill after. `corrected` and trusted `aligned` songs are never enqueued.
- **Reuse**: the admin "re-align" batch (`lyric_realignments`) is folded into the same job table, so there is one queue and one set of limits.
- **Acceptance**: a historical song with an estimated timeline gets synced automatically after it is opened, without the owner doing anything. A `corrected` song is not touched. When the cap is reached the song shows `unavailable`, never pretends to be "syncing", and is picked up again the next day.

## L6 Retiring manual alignment (separate ticket, starts after L4 meets the bar)

Inventory of today's callers (master `c969ae0`):

| Surface | Location | Retired |
| --- | --- | --- |
| Lyrics area | `SyncedLyrics.tsx` | "Adjust timing" entry, whole-song offset ±0.5 s (`nudge`), draft save (`onSaveTimings` / `markCorrected`), the tapping hint while playing |
| Lyrics area | `SongDetail.tsx` | `saveTimings` (the only web caller of `POST /v1/tracks/:id/lyric-timings`), the `LyricSyncStudio` mount around line 839 and `onSaveTimings` around line 982 |
| Video area | `PhotoVideo.tsx` + `LyricSyncStudio.tsx` | Dragging, tapping and typing per-line times, per-line nudge, undo/redo used only for timing edits, "accept proposal then save", and the "save the timing before exporting" block |
| Proposal flow | `routes/lyric-proposals.ts`, `services/lyric-proposal.ts` | The "proposal → save by hand" ending. The queue, deduplication and audio-reading code is reused by L4 |
| Legacy write endpoint | `POST /v1/tracks/:id/lyric-timings` | Two steps. First, when the entries are removed, stale tabs get a 409 with an "update the page" notice. Then, once no calls show up in production logs, the route is removed |
| Copy / styles / checks | three-language `i18n-*` (41 `lyrics.sync`/`sync.` keys), `styles.css`, the `check:ui` page states | Removed together with the entries, keeping `check:i18n` and `check:orphans` green |

**Kept**: the waveform and playhead (playback and seeking); saved `corrected` timelines (still readable and still protected); `.lrc` export; the admin re-align and troubleshooting tools.
**Searched**: `apps/air` and iOS have no timing-write calls (grep `lyric-timings` / `LyricSyncStudio` hit only the 4 web files above). Before starting, open PRs will be searched once more.
**Acceptance**:
- The current page, old links and direct requests can no longer write a timeline by hand.
- Songs that were corrected in the past play and export as before.
- A failure falls back to a trusted earlier version or static lyrics.

## L5 Paid models (only if the benchmark shows a gap)

Run on the same bench set and the same scorer. Prices, data handling, training use and retention are checked on the official pages before any call and written into the experiment record. A one-off experiment is capped at **$5** and needs the owner's approval.
