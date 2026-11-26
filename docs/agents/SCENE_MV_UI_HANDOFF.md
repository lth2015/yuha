# AI scene MV: T8 UI handoff

Base: master `830765dd30bd4c94395567f25cc0b16e4c325132`. Branch: `codex/scene-mv-ui-mac-20261126`.
Scope: [T8 brief](CODEX_SCENE_MV_UI.md), from PR #135. This implements the Web interface against the existing T7 API. API, worker, database, production switches and payments are unchanged.

At push time, another implementation was discovered on `codex/scene-mv-ui` at `f50c537` (base `df61255`). That remote branch was preserved; this Mac implementation was renamed instead of overwriting it. The two frontends overlap. This is an independent draft delivery for Claude to compare and integrate as one coherent implementation, not a request to stack both components.

## Behavior delivered

- Song owners see the entry inside the existing video card only when their authenticated runtime returns `features.sceneMv`. The photo and cover paths remain available.
- A chorus-based excerpt, or the middle of a song without a chorus, defaults to 30 seconds and stays within the song and the 32-second limit. Audition uses the existing song player; starting the video preview pauses that player.
- Three original, text-free SVG style references total 6 KB or less. They are explicitly illustrations, not model output. All product copy is in the three dictionaries.
- Creating a storyboard starts no generation. Four editable scene descriptions are reviewed, saved by PATCH, and explicitly started. Unsaved lyric timing blocks confirmation. Long server-generated prompts show their length and require editing before confirmation.
- Task status is recovered from the song's server list, with an ongoing task preferred. Progress uses server `drawn/total`, queue/generation/composition states and contention information; there is no invented percentage or countdown. Twelve-second polling stops in a background tab or folded panel.
- A conflicting task can be opened on its actual song. Lost start responses are reconciled by reading the task rather than replaying the write. Starting/cancelling/deleting invalidates older list reads, so a delayed refresh cannot overwrite cancellation.
- Both folds retain unsubmitted storyboard edits within the tab and pause hidden videos. Navigation/reload recovers persisted tasks; unsubmitted edits are not claimed to survive navigation.
- Ready videos display the server's expiry date. A fresh signed link is fetched without sending the account token to file storage; the MP4 `ftyp` header is checked before creating a video File. Download stays available where native file sharing is unavailable. Cancellation/failure copy states no song credits spent; failure text comes from a fixed code map.

## Acceptance evidence

The local stack used isolated schemas, simulated payments, demo music/video providers and synthetic content. It made no production or GPU requests.

- Browser lifecycle: four-scene draft → edit → fold/reopen → explicit start → leave/return to the same task → ready → actual preview/download. A second task was cancelled and remained cancelled after worker ticks; deleting its MV preserved the song.
- Actual downloaded MP4: 720×1280, 30 seconds, H.264 video and AAC audio, 6,571,024 bytes. Server expiry was seven days away. Song credit balance was unchanged by all MV operations.
- Chrome playback-state probe: both folds paused a started video, preserved its downloaded file, and reopening did not auto-resume it. This establishes playback state, not audible quality.
- Reduced-motion inspection: zero running animations in the scene-MV subtree.
- Seventeen DOM/HTTP-boundary tests pass, including hidden polling, stale reads after cancellation, uncertain writes, both folds, MIME compatibility and rejection of a mislabeled HTML response.
- Build, Web typecheck, i18n key/placeholder parity, contrast, orphan-export and stewardship shape checks pass. Stewardship had no local exact-value list and makes no exact-identity verification claim.
- UI result and final full-suite result are recorded in this PR once complete. The new five states explicitly request all three languages at 360/393/768/1280; the existing larger-width matrix for other pages is unchanged.

Actual synthetic browser screenshots (viewport captures; lower form sections require scrolling):

| Setup, phone | Setup, desktop | Storyboard | Ready demo video |
| --- | --- | --- | --- |
| [393 px](visual-previews/scene-mv-ui-20261126/setup-phone.jpg) | [1280 px](visual-previews/scene-mv-ui-20261126/setup-desktop.jpg) | [393 px](visual-previews/scene-mv-ui-20261126/draft-phone.jpg) | [393 px](visual-previews/scene-mv-ui-20261126/ready-phone.jpg) |

## Integration follow-up and limits

The signed local-storage endpoint currently labels MP4 files `audio/mpeg`. The UI verifies container bytes and wraps the file with the correct type; the API mapping still needs correction on Claude's branch. This was reported on [PR #135](https://github.com/lth2015/yuha/pull/135#issuecomment-7189061666). No storage signature or permission check was bypassed.

Local Homebrew FFmpeg 8.0.1 lacks the `subtitles`/libass filter. Instrumental export passed, but the two existing vocal/subtitle integration cases cannot pass with that binary. A real GPU output, audible quality/synchronization, physical iPhone/Android, native share sheet delivery, 20-song quality study and production/CDN behavior remain unverified. The 6–12-minute copy is the brief's estimate, not a measured service SLA. Licensing, privacy approval, production rollout and pricing remain with the existing T2/T9/T10/T11 owners.

`check:limits` also fails on the unchanged baseline `IssueQueue.tsx` field `maxLength={500}`. This UI PR does not modify that component or weaken the gate.

## Review

Standards and Spec were reviewed independently before commit. The delayed-refresh race, misleading directional copy, fold state/edit loss and hidden media playback were corrected and rechecked. Both review axes report zero unresolved findings. Final local/CI results belong to the exact implementation commit and should be read from the PR, not inferred from this base SHA.
