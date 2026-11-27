# YUHA music service on DGX Spark (ACE-Step)

## What production runs (checked on the Spark, 2026-11-22)

**ACE-Step 1.5**, not v1. The Spark's `.env` and the running `yuha-music`
container both say `ENGINE=v15`, and `GET /healthz` reports `"engine":"v15"`.
The `music` service here still takes YUHA's jobs, does the lyric alignment and
the mastering; the render itself goes to the `acestep15` service beside it
(`acestep-v15-xl-turbo`, with the `acestep-5Hz-lm-4B` planner, `pt` backend).

`ENGINE` defaults to `v1` in `server/app.py`, so this repository on its own
reads as v1. It is not. Check the machine, not the default:

```bash
cd ~/yuha-spark && grep '^ENGINE=' .env
docker compose exec -T music curl -s localhost:8000/healthz   # "engine"
```

Back to v1: `ENGINE=v1` in `.env`, then `docker compose up -d music`.

Memory: the GB10's 128 GB is shared by CPU and GPU. On 2026-11-22 a vLLM
process unrelated to YUHA held about 94 GB of it, and the music log had a
`CUBLAS_STATUS_INTERNAL_ERROR` job failure (2026-11-21 13:19 UTC) and a
`cudaErrorNotPermitted` alignment failure. Memory pressure is the likely cause
and is not confirmed. 1.5 keeps more resident than v1, so look at
`nvidia-smi` first when renders start failing.

## Run order (on the Spark)

```bash
# from your Mac
scp -r ~/workplace/yuha-spark <user>@<spark-ip>:~/
# on the Spark (in iTerm)
cd ~/yuha-spark && chmod +x *.sh
./00_check_gpu.sh          # paste output back — capability must be (12, x) and matmul ok
./01_deploy.sh             # build + start (first run downloads weights to ~/.cache/ace-step)
python3 02_acceptance.py --quick   # one 30s job, smoke test
python3 02_acceptance.py           # full checklist, paste the SUMMARY back
```

If `01_deploy.sh` fails at the "torch was replaced" assertion, that is the ARM64 risk from §2 — paste `build.log` back.

## Values for YUHA (`MUSIC_*`)

| item | value |
|---|---|
| baseUrl | `AUDIO_BASE_URL` in `.env`, e.g. `http://192.168.x.x:8000` |
| submitPath | `/v1/jobs` |
| pollPath | `/v1/jobs/{id}` |
| MUSIC_REQUEST_ID_FIELD | `id` |
| MUSIC_STATUS_FIELD | `status` |
| MUSIC_AUDIO_URL_FIELD | `audio_url` |
| MUSIC_STATUS_MAP | `queued→pending, running→pending, succeeded→completed, failed→failed, rejected→rejected` |
| MUSIC_IDEMPOTENCY_HEADER | `Idempotency-Key` (supported) |
| MUSIC_ALLOWED_AUDIO_HOSTS | the Spark IP |
| API key | `YUHA_API_KEY` in `.env` |

HTTP codes: 200 submit/poll · 401 bad key · 422 invalid input · 429 queue full (`Retry-After: 60`) · 404 unknown id. No redirects.
Audio URL is HMAC-signed, valid 24h (`AUDIO_URL_TTL_SECONDS`), served as `audio/mpeg`, no auth header needed.
`rejected` exists in the status set but this build has no content filter, so it is only reachable via 422 on submit.

## Static IP

The audio host is whitelisted, so the Spark IP must not change. Either a DHCP reservation on the router (preferred), or:
```bash
nmcli con show                       # find the active connection name
sudo nmcli con mod "<name>" ipv4.method manual ipv4.addresses 192.168.x.x/24 ipv4.gateway 192.168.x.1 ipv4.dns 192.168.x.1
sudo nmcli con up "<name>"
```
Then update `AUDIO_BASE_URL` in `.env` and `docker compose up -d`.

## Ops

- Logs: `docker logs -f yuha-music` · Restart: `docker compose restart` · Stop: `docker compose down`
- Auto-start: `restart: unless-stopped` + `systemctl enable docker` (done by 01_deploy.sh)
- Jobs/mp3: `./data/` · Weights: `~/.cache/ace-step/checkpoints`
- Quality/speed knob: `ACE_INFER_STEPS` in `.env` (default 60; 27 is ACE-Step's fast setting)

## Choosing an aligner (`server/bench_align.py`)

Runs beside the service, never in it: separates each recent sung song once,
aligns it with Whisper (today's path) and with Qwen3-ForcedAligner-0.6B
(Apache-2.0 weights and code), and reports how many lines each timed and how
far Qwen's starts are from the lines Whisper heard whole. Per-song JSON goes
to the output folder for listening. On the Spark:

```bash
mkdir -p ~/yuha-bench/out   # bench_align.py and align.py copied here
cd ~/yuha-spark
docker compose run --rm --no-deps -v ~/yuha-bench:/bench --entrypoint "" music bash -lc '
  python -m venv --system-site-packages /tmp/q &&
  /tmp/q/bin/pip install -q --no-deps qwen-asr==0.0.6 accelerate==1.12.0 &&
  /tmp/q/bin/pip install -q transformers==4.57.6 nagisa==0.2.11 soynlp==0.0.493 qwen-omni-utils psutil &&
  /tmp/q/bin/python -c "import torch; print(torch.__version__, torch.cuda.is_available())" &&
  cd /bench && PYTHONPATH=/bench:/opt/server /tmp/q/bin/python bench_align.py --songs 10 --out /bench/out'
```

With hand-timed staff songs (`pnpm bench:lyric-truth`, docs/quality/LYRIC_BENCH.md), put the
export in `~/yuha-bench/truth` and replace `--songs 10` with `--truth /bench/truth`: routes for
the repository's scorer are written beside it.

The venv is gone when the container exits; the Qwen weights (~1.8 GB) stay
in `~/.cache/huggingface`. Agreement with Whisper is a proxy (Whisper's own
starts run early in places); human-corrected timelines are the ground truth
to score against next.

## Qwen3-ForcedAligner (`ALIGN_METHOD=qwen`, off by default)

The known lyrics placed on the vocal stem by Qwen3-ForcedAligner-0.6B
(Apache-2.0 weights and code). It times every line where Whisper on the stem
heard about 70% of them. On dgxa's first six songs (2026-11-27) its starts ran a
steady +0.32 s behind Whisper's on the lines Whisper heard whole, in 84% of
them. That reads as Whisper's known early word clock rather than Qwen being
late, but it is only settled by hand-timed songs (docs/quality/LYRIC_BENCH.md).

- **Where it runs.** It needs transformers 4.57 and ACE-Step pins 4.50, so it
  has its own venv, `/opt/qwenv` (Dockerfile). The service runs it as one
  long-lived worker process (`server/qwen_worker.py`, started by
  `server/qwen_align.py` on first use). The model loads once, in about 15 s,
  and its weights (1.8 GB) are cached in `~/.cache/huggingface`. After that,
  a song takes well under a second.
- **Per-line confidence (`align.qwen_lines`).** A forced aligner times every
  line, right or not, and it fails by putting a line where nobody sings. A
  line is set to 0.3 confidence, under YUHA's 0.5 rule, when:
  - it starts where the vocal stem is silent; or
  - Whisper, which still runs on the stem, heard that line whole more than
    1.5 s away.

  A line it left out is filled in with 0 confidence.
- **Qwen and Whisper averaged (`ALIGN_QWEN_WEIGHT`, default 0.5; product owner's suggestion,
  2026-11-27).** Where both trust a line and agree within 1 s, its start is the weighted
  average of the two (`align.fuse_lines`). Whisper's steady early offset is taken out first,
  using the median per song over at least 3 shared lines. Without that step, the average
  would put every line halfway into Whisper's earliness. A line they disagree on, or one
  Whisper did not hear whole, keeps Qwen's time. `1.0` means Qwen alone. The weight is
  meant to be set from hand-timed songs, where `bench_align.py` scores `fused` as a third
  route. The response carries `qwen_weight` and the song's `whisper_offset`.
- **When Whisper's answer is used instead.** Below `ALIGN_QWEN_MIN_TRUSTED`
  (0.6) of the lines trusted, the result falls back to Whisper's, unchanged.
  So does any failure: a worker that dies, times out
  (`QWEN_TIMEOUT`, 300 s), or is not installed.
- **The response.** `method: qwen`, `model: qwen3-forced-aligner-0.6b`,
  `coverage` (the share of trusted lines), `whisper_coverage`, and
  `partial: true` when some lines are unsure.
- **Health.** `/healthz` reports `align_method` and, under `qwen`, whether
  the worker is installed and running, with its last error.

To check the service's own path on the Spark (the worker in `/opt/qwenv`,
the fusion, the fallbacks) without switching the running service:

```bash
cd ~/yuha-spark
docker compose run --rm --no-deps -e ALIGN_METHOD=qwen --entrypoint "" music python bench_service_align.py --songs 3
```

**Per request (2026-11-27).** `POST /v1/align` takes an optional
`"method": "whisper" | "qwen"`, which overrides `ALIGN_METHOD` for that
request only. YUHA sends it according to `LYRIC_ALIGNER` (off / staff / all,
decided by who owns the song), so the box's `.env` stays `whisper`. MMS_FA
cannot be requested this way; only `.env` can turn it on. A box older than
this ignores the field and aligns as before.

Turn it on only after the hand-timed scores agree, and only once
`LYRIC_STRICT_TIMELINE=all` in YUHA. Until then, a customer's view would
light the unsure lines.

```bash
cd ~/yuha-spark && grep -q '^ALIGN_METHOD=' .env && sed -i 's/^ALIGN_METHOD=.*/ALIGN_METHOD=qwen/' .env || echo 'ALIGN_METHOD=qwen' >> .env
docker compose up -d music
```

## Official BGM batches (`server/bench_official_inventory.py`)

The Marketplace's official BGM are made outside the service, by a script run by
hand, and kept on the Spark in a folder of their own — **not** under
`~/yuha-spark/data/`, which retention empties after six days, and never in the
repository, which is public:

```
~/yuha-official-bgm/batch-01/
  manifest.csv   id,file,title,series,style,mood,scenario,cover,model,model_version,seed,prompt,generated_at,note
  masters/       the audio exactly as generated; not converted, not trimmed
  covers/        <id>.jpg|png|webp, or the file the manifest's cover column names
  generation/    whatever the generating script left, as is
```

Keep a copy on the Mac too: `rsync -a dgxa:yuha-official-bgm/batch-01 ~/yuha-official-bgm/`.

What is in it and what is still missing, read-only (the batch mounted `:ro`):

```bash
cd ~/yuha-spark && docker compose run --rm --no-deps \
  -v ~/yuha-official-bgm:/bgm:ro --entrypoint "" music \
  python bench_official_inventory.py /bgm/batch-01
```

Per track: format, sample rate, channels, bit depth, bit rate, real length,
peak and RMS level, clipped samples, silence at either edge, sha256, the
manifest columns still empty and whether a cover exists. Per batch: a master no
row names, a row whose file is gone, a repeated id, the same audio twice, and a
count other than 30. Exit 0 only when every track is complete; 2 when there was
nothing to check. `--json` prints the whole report for keeping; the sha256s are
what later proves the master YUHA sells is the one reviewed.

## Retention (`RETENTION_DAYS`, default 6)

`data/jobs/*.json` holds what YUHA sent (the brief and the lyrics) and
`data/audio/` what came back. Both used to be kept forever, which the privacy
text cannot promise (docs/legal/PRIVACY_CHANGES_2026-11.md). The server now
deletes finished jobs and their audio older than `RETENTION_DAYS`, at start
and every hour; queued and running jobs are never touched. YUHA has its own
copy of a finished song within minutes. Six days, because a song made without
an account is promised deleted, inputs and all, seven days after it was made,
and this is one of its copies: six days plus an hourly sweep is inside seven.
It is read from `.env` (`env_file`), so changing it needs only
`docker compose up -d music`, no rebuild. `0` keeps
everything (benchmarks only). Takes effect on the Spark only after the image
is rebuilt and the container restarted (`01_deploy.sh`); this box is not
deployed by the Deploy QA workflow.

## Lyric alignment (`POST /v1/align`)

**Off by default since 2026-11-27.** MMS_FA's weights are CC-BY-NC
(docs/legal/MUSIC_LICENSE_AUDIT_2026-11-27.md); the product owner chose
Whisper on the vocal stem until that is settled, so `ALIGN_METHOD` defaults
to `whisper` and the paragraph below describes what `ALIGN_METHOD=forced`
turns back on.

**Forced alignment (`server/forced.py`, `ALIGN_METHOD=forced`).** Whisper was being asked to transcribe a song whose words we
already know. Now the known lyrics are romanised (fugashi + cutlet, pypinyin
and hangul-romanize are already in the image for ACE-Step) and placed on the
vocal stem by torchaudio's MMS_FA CTC model.

- forced_align runs on its CPU kernel, because the image builds torchaudio
  without CUDA. The model itself runs on the GPU.
- Digits and acronyms (JPYC) are star tokens.
- If at least `ALIGN_FORCED_MIN_COVERAGE` (0.6) of the lettered units were
  found, that result is returned with `method: forced`, `model: mms-fa`.
  Otherwise everything below runs as before.
- The log line is `forced alignment <job> coverage=…`.
- The weights (~1.2GB) download to `~/.cache/torch` on the first alignment.
- `ALIGN_METHOD=forced` in `.env` turns it on, `whisper` off, without a
  rebuild (`docker compose up -d music`).

**Then, or instead:** Whisper (`WHISPER_MODEL`, default `turbo`) supplies the clock; the known
lyrics are matched onto its words character by character (`server/align.py`).
On the full mix that clock smears across instrumentals: the first line after
an interlude lit up while the band was still playing, and the last line before
one stayed lit through it. So the vocal is taken out first:

**Per-line confidence on the Whisper path (2026-11-27).** Every line now
carries `confidence`: the share of its characters Whisper heard in runs of two
or more (a lone matched character counts half), and 0 for a line whose time
was filled in between its neighbours or dropped for breaking their order.
YUHA's shared rule leaves a line under 0.5 unlit, out of videos and out of the
`.lrc`. With `ALIGN_PARTIAL_MIN_COVERAGE` set below `ALIGN_MIN_COVERAGE`
(0.85), a song in between comes back `partial: true` instead of 422. It is
**off by default** (equal to 0.85): YUHA applies the rule to staff only while
`LYRIC_STRICT_TIMELINE=staff`, and anyone else would see an unheard line lit.
Set it, e.g. `ALIGN_PARTIAL_MIN_COVERAGE=0.5` in `.env`, once the rule is on
for everyone.

- **Demucs (`htdemucs`) separates the vocal** (`server/separate.py`) and
  Whisper transcribes the stem. If the stem hears less of the lyrics than the
  mix, the mix is transcribed too and the better match kept.
- **The stem's loudness is the record of where singing is.** A line whose
  start falls in silence moves to where the voice comes back (never past the
  first character Whisper heard in it); an end that falls in silence moves
  back to where the voice stopped.
- **A lone matched character no longer sets a line's time.** A common
  character found inside another line's mumble used to start its line seconds
  early.

The response says what was used: `heard` (`vocal_stem` / `mix`) and
`voice_activity`; the log line `aligned … heard=… voiced=…` says the same.
`/healthz` → `separation` reports whether demucs loaded. Weights (~80MB)
download to `~/.cache/torch` on first use. `ALIGN_SEPARATE=off` in `.env`
returns to aligning on the mix without a rebuild.

This runs on the DGX, so merging changes nothing here: `./update.sh` rebuilds
the music service when `server/` changed. Songs already made keep the timings
they were given — an admin re-aligns them from the console (docs/LYRIC_ALIGNMENT.md).

**The song itself, sent (`audio_b64`, 2026-11-26).** `/v1/align` also takes the
audio in the request, base64, instead of `audio_url`: YUHA keeps every song,
this server keeps renders `RETENTION_DAYS`, so "align it again" on an older
song — or one this server did not render — sends the song. It is written to
`$DATA_DIR/tmp/align-*.mp3` for the length of the request and removed when the
answer is back; one left by a crash mid-request goes in the hourly retention
sweep, whatever `RETENTION_DAYS` is. `audio_url` works as before.

Check after `./update.sh` (from anywhere that reaches the service):

```bash
curl -s -X POST "$BASE/v1/align" -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"lyrics":"x","audio_b64":"!!!!!!!!","duration_seconds":10}'
```

The updated service answers `{"detail":"audio_b64 is not base64"}`. The old one
answers a validation error about `audio_url` (it does not know the field).
Only after the first answer is `FEATURE_LYRIC_AUTO_ALIGN_ENABLED` set to
`"true"` in `deploy/k8s/qa/resources.yaml`.

## Still to confirm (§3)

- License / output rights: read the model card + LICENSE text directly — https://huggingface.co/ACE-Step/ACE-Step-v1-3.5B and https://github.com/ace-step/ACE-Step — and quote the relevant lines, not just "commercial OK".
- Speed: the acceptance summary reports `gen_s` and `rtf` (generation seconds / audio seconds), warm model, on this Spark.
