#!/usr/bin/env bash
# Ship the current commit to the DGX — both stacks — and prove it arrived.
#
# Run on the Mac that can `ssh dgx`:
#     cd deploy/dgx && ./update.sh
#
# Options (env):
#   DGX=dgx          ssh host
#   MUSIC=auto       auto | yes | no — whether to rebuild the music service
#   ALLOW_DIRTY=1    deploy a working tree with uncommitted changes
#   SKIP_APP=1       music service only
#
# Why this exists on top of deploy_yuha.sh, which already does the app well:
#
#   1. Nothing updated the music service unless somebody remembered to. Its
#      code is COPYed into the image, so a stale container keeps serving the
#      old app.py and says nothing about it. That decision is made by
#      comparing hashes here, not by judgement.
#   2. Nothing checked afterwards. `3da18de` exists because a redeploy left
#      the whole site answering 502 — nginx had resolved `api` once at start
#      and kept proxying to a container that no longer existed — and the way
#      that was found was somebody failing to sign in. A deploy that prints a
#      URL it never fetched is a deploy that reports success it did not check.
#   3. Nothing recorded what was deployed, so "it's the latest" was not a
#      claim anyone could test.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
DGX="${DGX:-dgx}"
MUSIC_MODE="${MUSIC:-auto}"
MR='~/yuha-spark'
AR='~/yuha-app'

say() { printf '\n== %s\n' "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- what ships
SHA=$(git -C "$ROOT" rev-parse --short HEAD)
BRANCH=$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)
DIRTY=$(git -C "$ROOT" status --porcelain)

say "shipping $BRANCH @ $SHA"
if [[ -n "$DIRTY" ]]; then
  # deploy_yuha.sh tars `git ls-files` — tracked paths at their WORKING TREE
  # content — so uncommitted edits do ship, under a commit id that does not
  # contain them. Then the box reports a SHA whose code is not what is running.
  echo "$DIRTY" | sed 's/^/     /'
  [[ "${ALLOW_DIRTY:-}" == "1" ]] || die "working tree is dirty; commit first, or re-run with ALLOW_DIRTY=1"
  echo "   (ALLOW_DIRTY=1: the recorded commit will not match what is running)"
  SHA="$SHA+dirty"
fi

PREV=$(ssh "$DGX" "cat $AR/.deployed 2>/dev/null" || true)
[[ -n "$PREV" ]] && echo "   currently on the box: $PREV"

# ------------------------------------------------------- 1. the music service
# Hash what actually goes into the image: the Dockerfile COPYs server/ whole,
# so a change to any file in it — not just app.py, which is all the README used
# to copy — means the running container is stale.
# Portable on purpose: `sort -z` and `xargs -0` are GNU, and this runs on a
# Mac. Sorting shasum's OUTPUT rather than the file list is stable whatever
# order find walks in, and does not care about spaces in a name.
#
# The Dockerfile and docker-compose.yml are part of the image too. They were
# left out at first, and that is exactly how the box ended up without Whisper:
# server/ was current, the Dockerfile that installs openai-whisper was not,
# and /healthz said aligner_error "No module named 'whisper'" — so lyrics fell
# back to an estimated timeline while every check here passed.
#
# Two hashes, because not everything in the image can change what the service
# does. The first version of this restarted a GPU service for two and a half
# minutes of model loading because a *benchmark script* had been added beside
# it. The service never imports bench_*.py — `docker compose run` does, out of
# the image — so a bench change rebuilds the image, which it must to be
# runnable at all, and leaves the running container alone.
hash_of() { ( cd music && find server Dockerfile docker-compose.yml -type f \
  -not -name '*.pyc' "$@" -exec shasum {} + | LC_ALL=C sort | shasum | awk '{print $1}' ); }
SERVICE_HASH=$(hash_of -not -name 'bench_*.py')
IMAGE_HASH=$(hash_of)
REMOTE_SERVICE=$(ssh "$DGX" "cat $MR/.server-hash 2>/dev/null" || true)
REMOTE_IMAGE=$(ssh "$DGX" "cat $MR/.image-hash 2>/dev/null" || true)

NEED_MUSIC=no      # rebuild AND restart: what the service runs has changed
NEED_IMAGE=no      # rebuild only: the image changed, but not the running service
case "$MUSIC_MODE" in
  yes) NEED_MUSIC=yes ;;
  no)  : ;;
  *)   [[ "$SERVICE_HASH" != "$REMOTE_SERVICE" ]] && NEED_MUSIC=yes
       [[ "$IMAGE_HASH"   != "$REMOTE_IMAGE"   ]] && NEED_IMAGE=yes ;;
esac

# files only: server/ holds a __pycache__ directory, and scp without -r
# refuses a directory and exits non-zero, which `set -e` turns into a stop
upload_music() {
  ssh "$DGX" "mkdir -p $MR/server ~/.cache/whisper"
  scp -q music/server/*.py music/server/requirements.txt "$DGX:yuha-spark/server/"
  scp -q music/Dockerfile music/docker-compose.yml "$DGX:yuha-spark/"
}

if [[ "$NEED_MUSIC" == yes ]]; then
  say "music service: code differs, rebuilding (a couple of minutes; weights are cached)"
  upload_music
  # --build is required: a plain `up -d` restarts the container with the old
  # COPY of the code still inside it, and reports success.
  ssh "$DGX" "cd $MR && docker compose up -d --build music"
  ssh "$DGX" "echo '$SERVICE_HASH' > $MR/.server-hash; echo '$IMAGE_HASH' > $MR/.image-hash"
elif [[ "$NEED_IMAGE" == yes ]]; then
  say "music service: only files it does not run changed (benchmarks) — rebuilding the image, not restarting it"
  upload_music
  ssh "$DGX" "cd $MR && docker compose build music"
  ssh "$DGX" "echo '$IMAGE_HASH' > $MR/.image-hash"
else
  say "music service: unchanged since the last deploy, left alone"
fi

say "music service: waiting for the model"
MUSIC_PORT=$(ssh "$DGX" "sed -n 's/^HOST_PORT=//p' $MR/.env 2>/dev/null" || true)
MUSIC_PORT="${MUSIC_PORT:-8000}"
HEALTH=""
for _ in $(seq 1 60); do
  HEALTH=$(ssh "$DGX" "curl -fsS --max-time 5 http://127.0.0.1:$MUSIC_PORT/healthz" 2>/dev/null || true)
  [[ "$HEALTH" == *'"model_loaded":true'* ]] && break
  sleep 5
done
[[ "$HEALTH" == *'"model_loaded":true'* ]] \
  || die "music service never reported model_loaded — ssh $DGX 'docker logs --tail 40 yuha-music'"
echo "   generator ok"

# Lyric sync depends on a SECOND model, reported separately by /healthz, and
# loaded about ninety seconds after the generator. Checking only for an error
# left that window silent: the deploy said ok, and every song made in it
# rendered perfectly well with lyrics timed by the estimator rather than
# heard — which is the 估算同步 pill, a day later, on a song nobody can
# explain. So wait for it, and only then decide what to say.
for _ in $(seq 1 36); do
  [[ "$HEALTH" == *'"aligner_loaded":true'* ]] && break
  sleep 5
  HEALTH=$(ssh "$DGX" "curl -fsS --max-time 5 http://127.0.0.1:$MUSIC_PORT/healthz" 2>/dev/null || true)
done
if [[ "$HEALTH" == *'"aligner_loaded":true'* ]]; then
  echo "   aligner ok"
elif [[ "$HEALTH" == *"No module named"* ]]; then
  echo "   !! aligner missing: $(printf '%s' "$HEALTH" | grep -o '"aligner_error":"[^"]*"')"
  echo "      lyrics will follow an estimated timeline. Re-run with MUSIC=yes to rebuild the image."
else
  echo "   !! the aligner is still not loaded after three minutes."
  echo "      Songs generated now will render, but their lyrics will be timed by"
  echo "      the estimator rather than heard: ssh $DGX 'docker logs --tail 40 yuha-music'"
fi

# ------------------------------------------------------------------ 2. the app
if [[ "${SKIP_APP:-}" == "1" ]]; then
  say "app: skipped (SKIP_APP=1)"
else
  say "app: deploy_yuha.sh (builds, migrates, seeds, restarts)"
  ( cd app && DGX="$DGX" ./deploy_yuha.sh )
fi

# -------------------------------------------------------------- 3. prove it
IP=$(ssh "$DGX" "ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if(\$i==\"src\") print \$(i+1)}'")
APP_PORT=$(ssh "$DGX" "sed -n 's/^APP_PORT=//p' $AR/.env 2>/dev/null" || true)
APP_PORT="${APP_PORT:-8580}"
URL="http://$IP:$APP_PORT"

say "checking $URL from the DGX itself"
GET() { ssh "$DGX" "curl -fsS --max-time 10 'http://127.0.0.1:$APP_PORT$1'" 2>/dev/null || true; }

# The API, through nginx — not through the api container's own port. The 502
# this guards against lives in nginx's view of the api, so asking the api
# directly would pass while the site was down.
#
# And /v1/auth/config, not /health: nginx proxies only /v1/, so /health falls
# through to `try_files $uri /index.html` and answers 200 with the SPA shell.
# A check that cannot fail is not a check.
CONFIG=$(GET /v1/auth/config)
[[ "$CONFIG" == *'{'* ]] || die "the API is not answering through nginx — the site is down. ssh $DGX 'cd $AR && docker compose logs --tail 40 web api'"
echo "   api  ok"

INDEX=$(GET /)
[[ "$INDEX" == *'<div id="root"'* || "$INDEX" == *'<!doctype html'* ]] || die "the web root did not return the app"
ASSET=$(printf '%s' "$INDEX" | grep -o '/assets/[A-Za-z0-9._-]*\.js' | head -1)
[[ -n "$ASSET" ]] || die "index.html references no built script — the web assets did not build"
ssh "$DGX" "curl -fsS -o /dev/null --max-time 10 'http://127.0.0.1:$APP_PORT$ASSET'" \
  || die "index.html points at $ASSET, which 404s — the build and the page disagree"
echo "   web  ok ($ASSET)"

# The Stripe webhook path, which is the one failure here that is silent.
#
# `/api/` is a separate nginx location from `/v1/`. If it is missing, this POST
# falls through to `try_files $uri /index.html` and nginx answers 200 with the
# page shell — to a POST, carrying a Stripe signature. Stripe reads 200 as
# delivered and never retries, so a real payment would be acknowledged and
# dropped with nothing anywhere saying so.
#
# Unsigned on purpose: the API must answer 400, which the SPA cannot do and the
# api container can only do if the request reached it.
#
# The MESSAGE is checked and not only the code, because 400
# WEBHOOK_SIGNATURE_INVALID has two causes and only one of them is healthy.
# "signature verification failed" means the bytes arrived and the signature was
# absent — correct. "raw body was not preserved" means the route is served but
# the content-type parser no longer hands the buffer through, in which case
# every real event is refused too, and a check that accepted any 400 would
# print ok while the endpoint rejected Stripe all day.
WEBHOOK=$(ssh "$DGX" "curl -s -o /tmp/wh.out -w '%{http_code}' --max-time 10 \
  -X POST -H 'content-type: application/json' --data '{}' \
  'http://127.0.0.1:$APP_PORT/api/webhooks/stripe'; cat /tmp/wh.out; rm -f /tmp/wh.out" 2>/dev/null || true)
case "$WEBHOOK" in
  400*'signature verification failed'*) echo "   hook ok (400, unsigned refused)" ;;
  *)
    # A run that deployed nothing cannot be blamed for the box's routing, and
    # the first SKIP_APP=1 run after this check was added would otherwise fail
    # on a box that has not yet received the nginx change.
    MSG="POST /api/webhooks/stripe answered '$WEBHOOK' — expected 400 with \"signature verification failed\". A 200 carrying HTML means nginx has no /api/ location and Stripe events are being swallowed; a 400 saying \"raw body was not preserved\" means the route is served but the raw body is gone."
    if [[ "${SKIP_APP:-}" == "1" ]]; then
      echo "   !! $MSG"
      echo "      (SKIP_APP=1: this run deployed no app, so this is not fatal — re-run without SKIP_APP.)"
    else
      die "$MSG"
    fi
    ;;
esac

ssh "$DGX" "echo '$SHA' > $AR/.deployed"

# ----------------------------------------------------------- 4. what to look at
say "up: $URL"
if [[ -n "$PREV" && "$PREV" != "$SHA" ]]; then
  RANGE="${PREV%%+*}..HEAD"
  if git -C "$ROOT" rev-parse --verify -q "${PREV%%+*}" >/dev/null; then
    echo
    echo "   new since the last deploy — this is what there is to accept:"
    git -C "$ROOT" log --no-merges --format='     %h %s' "$RANGE" | head -20
  fi
fi
cat <<'NOTE'

   The checks above prove the site is serving and the model is loaded. They
   cannot hear anything. What is left is the part only a person can settle:
   generate one song, and listen to whether the words land where the
   highlighted line says they do.
NOTE
