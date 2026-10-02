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
SERVER_HASH=$(cd music/server && find . -type f -not -name '*.pyc' -exec shasum {} + \
  | LC_ALL=C sort | shasum | awk '{print $1}')
REMOTE_HASH=$(ssh "$DGX" "cat $MR/.server-hash 2>/dev/null" || true)

NEED_MUSIC=no
case "$MUSIC_MODE" in
  yes) NEED_MUSIC=yes ;;
  no)  NEED_MUSIC=no ;;
  *)   [[ "$SERVER_HASH" != "$REMOTE_HASH" ]] && NEED_MUSIC=yes ;;
esac

if [[ "$NEED_MUSIC" == yes ]]; then
  say "music service: code differs, rebuilding (a couple of minutes; weights are cached)"
  ssh "$DGX" "mkdir -p $MR/server"
  scp -q music/server/* "$DGX:yuha-spark/server/"
  # --build is required: a plain `up -d` restarts the container with the old
  # COPY of the code still inside it, and reports success.
  ssh "$DGX" "cd $MR && docker compose up -d --build music"
  ssh "$DGX" "echo '$SERVER_HASH' > $MR/.server-hash"
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
echo "   ok"

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
