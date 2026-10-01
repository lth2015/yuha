# Deploying YUHA on the DGX Spark (intranet)

Two stacks on one DGX, both driven from a Mac that can `ssh dgx`.
These scripts used to live in a separate `~/workplace/yuha-spark` folder;
they are tracked here now so a change to the service ships with the code
that depends on it.

| folder | what | lives on the DGX at | port |
| --- | --- | --- | --- |
| `music/` | ACE-Step music service (FastAPI, GPU), plus ACE-Step 1.5 side by side | `~/yuha-spark` | 8583 |
| `app/` | YUHA itself: web + api + worker + MySQL + Stripe forwarder | `~/yuha-app` | 8580 |

## Music service (`music/`)

```bash
cd deploy/dgx/music
./05_try_v15.sh          # upload service code, start 1.5 next to v1, quick vocal bench
./05_try_v15.sh full     # full bench (≈1h); open bench_out/report.html
```

The first install used `scp -r` of this folder to `~/yuha-spark` and then
`00_check_gpu.sh` → `01_deploy.sh` → `02_acceptance.py` on the DGX.
`03_wire_yuha.sh` points a local dev stack (this repo's `.env`) at the
service; `04_yuha_provider_check.mjs` checks that wiring end to end.

Switches in `~/yuha-spark/.env` on the DGX (then `docker compose up -d music`):
`ENGINE=v1|v15`, `TAG_STYLE=v1|v2`, `VOCAL_TAKES=1|2`, `MAX_QUEUE` (30).

## YUHA app (`app/`)

```bash
cd deploy/dgx/app
./deploy_yuha.sh         # re-run any time to redeploy the current working tree
```

Ships the tracked files of this repo, rebuilds, migrates, seeds, and tops up
the shared team account (`yuha-team@netstars.co.jp`, 50 credits).

Sign-in on this build is the development sign-in: **no password**. It is
limited by `DEV_LOGIN_ALLOWLIST` (default `@netstars.co.jp`; pass
`DEV_LOGIN_ALLOWLIST=-` to open it to anyone). Because anyone allowed can
sign in as any allowed address, no account keeps the admin role: the seeded
`admin@example.jp` is demoted on every deploy, and the operator account is
admin only for the moment of the top-up.
