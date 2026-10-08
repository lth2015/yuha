# Deploying YUHA on the DGX Spark (intranet)

Two stacks on one DGX, both driven from a Mac that can `ssh dgx`.
These scripts used to live in a separate `~/workplace/yuha-spark` folder;
they are tracked here now so a change to the service ships with the code
that depends on it.

| folder | what | lives on the DGX at | port |
| --- | --- | --- | --- |
| `music/` | ACE-Step music service (FastAPI, GPU), plus ACE-Step 1.5 side by side | `~/yuha-spark` | 8583 |
| `app/` | YUHA itself: web + api + worker + MySQL + Stripe forwarder | `~/yuha-app` | 8580 |

## Updating both stacks to the latest commit

```bash
cd ~/workplace/music
git checkout master && git pull
cd deploy/dgx && ./update.sh
```

One command for both stacks. It runs **on the Mac that can `ssh dgx`**;
neither stack pulls from git on its own.

What it does that doing it by hand did not:

- **Decides whether the music service needs rebuilding by hashing
  `music/server/`**, not by remembering. That code is `COPY`ed into the image,
  so a container that was only restarted keeps serving the old `app.py` and
  reports success while doing it.
- **Checks the site afterwards, through the front door.** `3da18de` exists
  because a redeploy left the whole site answering 502 — nginx resolves `api`
  once at start, and every redeploy gives that container a new address — and
  the way it was found was somebody failing to sign in. The script fetches
  `/v1/auth/config` through nginx (not the api's own port, where the failure
  is invisible) and fetches the script `index.html` actually references, so a
  build that did not happen cannot pass.
  Note it does **not** use `/health`: nginx proxies `/v1/` and `/api/` only, so
  `/health` falls through to the SPA and answers 200 with the page shell. A
  check that cannot fail is not a check.
- **Checks that the Stripe webhook path is not the SPA.** Same shape as
  `/health`, with money behind it: a POST to a path nginx does not proxy comes
  back 200 with the page, Stripe reads 200 as delivered, and a real payment is
  acknowledged and dropped. The check POSTs unsigned and requires
  `400 WEBHOOK_SIGNATURE_INVALID` with the message `signature verification
  failed` — the message matters, because a routed path whose raw body was lost
  answers the same 400 with a different message.
- **Records the deployed commit** in `~/yuha-app/.deployed`, and on the next
  run prints the commits since it — which is the list of things to accept.

It refuses a dirty working tree, because `deploy_yuha.sh` ships tracked files
at their *working tree* content: uncommitted edits do go up, under a commit id
that does not contain them. `ALLOW_DIRTY=1` overrides it and marks the
recorded commit `+dirty`.

Both stacks restart containers, so anything mid-generation at that moment
dies. Since `d8460f6` that is survivable rather than permanent — an abandoned
job is swept after `JOB_UPSTREAM_DEADLINE_SECONDS` (1h) and its credit
released — but it is still a minute of other people's work, so pick a quiet
moment.

Other switches: `MUSIC=yes|no` forces or skips the music rebuild,
`SKIP_APP=1` does the music service alone, `DGX=` picks another ssh host.

### The migration step is the one to watch

`update.sh` delegates the app to `deploy_yuha.sh`, which tars this
repository's tracked files, uploads, rebuilds the API image, waits for MySQL,
**runs `pnpm db:migrate`**, seeds, builds the web assets, restarts
api/worker/web/stripe, and tops the shared team account back up. It reads the
Mac's `.env` for the secrets it carries over, so run it from a checkout that
has one.

Migrations change a schema holding everyone's songs. `0007`/`0008` add the
account-deletion tables and `0009` rewrites `asset_versions`'s unique key to
include `owner_id` — it adds the new key before dropping the old one, because
the old one was the only index the `track_id` foreign key could use, and
adding a column to a unique key only ever loosens it, so no existing row can
collide. If `db:migrate` fails, the old containers are still running and
nothing is half-deployed; paste the error rather than re-running.

### Checking the music service by hand

```bash
ssh dgx 'P=$(sed -n "s/^HOST_PORT=//p" ~/yuha-spark/.env); curl -s http://127.0.0.1:${P:-8000}/healthz'
# expect "model_loaded":true   (update.sh already waits for this)
cd deploy/dgx/music && ssh dgx 'cd ~/yuha-spark && python3 02_acceptance.py --quick'
```

Since `b06b08f` the service masters every render: loudness normalised to
−14 LUFS with a −1.5 dBTP ceiling, a 30 ms fade-in, a 1.5 s fade-out, and a
bail-out that refuses a near-silent result instead of delivering it. If a
generated song still ends abruptly or plays noticeably quieter than the rest,
the rebuild did not take — check `docker logs --tail 40 yuha-music`.

Nobody should see the 18+ consent banner on this build: sign-in here is the
dev sign-in, whose form already requires both checkboxes and records them, so
every account that can sign in is already confirmed. It exists for the Google
path, which this build does not use.

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

The bench's dense/sparse lyric configs map to the app's
`LYRIC_SECONDS_PER_LINE` (default 4.5 = dense; ~6.5 = sparse), set in the
repo `.env` and shipped by `deploy_yuha.sh`.

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
