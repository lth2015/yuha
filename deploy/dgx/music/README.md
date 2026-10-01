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

## Still to confirm (§3)

- License / output rights: read the model card + LICENSE text directly — https://huggingface.co/ACE-Step/ACE-Step-v1-3.5B and https://github.com/ace-step/ACE-Step — and quote the relevant lines, not just "commercial OK".
- Speed: the acceptance summary reports `gen_s` and `rtf` (generation seconds / audio seconds), warm model, on this Spark.
