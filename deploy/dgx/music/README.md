# YUHA music service on DGX Spark (ACE-Step)

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

## Lyric alignment (`POST /v1/align`)

Whisper (`WHISPER_MODEL`, default `turbo`) supplies the clock; the known
lyrics are matched onto its words character by character (`server/align.py`).
On the full mix that clock smears across instrumentals: the first line after
an interlude lit up while the band was still playing, and the last line before
one stayed lit through it. So the vocal is taken out first:

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
they were given.

## Still to confirm (§3)

- License / output rights: read the model card + LICENSE text directly — https://huggingface.co/ACE-Step/ACE-Step-v1-3.5B and https://github.com/ace-step/ACE-Step — and quote the relevant lines, not just "commercial OK".
- Speed: the acceptance summary reports `gen_s` and `rtf` (generation seconds / audio seconds), warm model, on this Spark.
