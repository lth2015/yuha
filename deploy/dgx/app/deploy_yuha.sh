#!/usr/bin/env bash
# Deploy the YUHA web app (web + api + worker + MySQL + Stripe forwarder) to the DGX.
# Run on your Mac:   ./deploy_yuha.sh            (re-run any time to redeploy the current code)
# Options (env):     APP_PORT=8580  TEAM_EMAIL=yuha-team@netstars.co.jp  TEAM_CREDITS=50  DGX=dgx
#                    DEV_LOGIN_ALLOWLIST=@netstars.co.jp   (who may sign in; "-" = anyone, not recommended)
set -euo pipefail
cd "$(dirname "$0")"
# The @netstars.co.jp addresses below are office test access for the internal
# build on the DGX, not the product's legal identity — that is the sole
# proprietor named in the deployment's secret store, and named nowhere in this
# repository at all. Seven or eight colleagues sign in with
# their work addresses, so clearing this allowlist locks them all out. Leave it.
DGX="${DGX:-dgx}"
MUSIC="$(cd ../../.. && pwd)"   # repo root (this script lives in deploy/dgx/app)
TEAM_EMAIL="${TEAM_EMAIL:-yuha-team@netstars.co.jp}"
TEAM_CREDITS="${TEAM_CREDITS:-50}"
ALLOWLIST="${DEV_LOGIN_ALLOWLIST:-@netstars.co.jp}"; [[ "$ALLOWLIST" == "-" ]] && ALLOWLIST=""
# the team top-up needs an admin for a moment; this address is promoted, used, and demoted again
OPERATOR_EMAIL="${OPERATOR_EMAIL:-yuha-operator@netstars.co.jp}"
R='~/yuha-app'

echo "== 1/6 DGX address and port"
IP=$(ssh "$DGX" "ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if(\$i==\"src\") print \$(i+1)}'")
EXISTING_PORT=$(ssh "$DGX" "sed -n 's/^APP_PORT=//p' $R/.env 2>/dev/null" || true)
if [[ -z "${APP_PORT:-}" ]]; then APP_PORT="$EXISTING_PORT"; fi
if [[ -z "${APP_PORT:-}" ]]; then
  APP_PORT=$(ssh "$DGX" 'for p in 8580 8581 8582 8590 8600 8680; do ss -ltn | awk "{print \$4}" | grep -qE "[:.]$p\$" || { echo $p; break; }; done')
fi
URL="http://$IP:$APP_PORT"
echo "   $URL"

echo "== 2/6 configuration (from music/.env, rewritten for the DGX)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# keep secrets/settings from the Mac, drop what is machine-specific, then pin the DGX values
grep -E '^[A-Z_][A-Z0-9_]*=' "$MUSIC/.env" \
  | grep -vE '^(GOOGLE_|VITE_|DATABASE_URL=|PORT=|HOST=|PUBLIC_WEB_URL=|PUBLIC_API_URL=|STORAGE_|DEV_AUTH_SECRET=|RUN_MODE=|AUTH_ADAPTER=|QUEUE_ADAPTER=|FEATURE_FREE_TRIAL_ENABLED=|MUSIC_BASE_URL=|MUSIC_ALLOWED_AUDIO_HOSTS=)' > "$TMP/app.env"
# reuse the DB password and signing secrets across redeploys
ssh "$DGX" "cat $R/.env 2>/dev/null; grep -E '^(DEV_AUTH_SECRET|STORAGE_SIGNING_SECRET)=' $R/app.env 2>/dev/null" > "$TMP/prev" || true
prev() { sed -n "s/^$1=//p" "$TMP/prev" | head -1; }
MYSQL_PASSWORD=$(prev MYSQL_PASSWORD); [[ -n "$MYSQL_PASSWORD" ]] || MYSQL_PASSWORD=$(openssl rand -hex 16)
MYSQL_ROOT_PASSWORD=$(prev MYSQL_ROOT_PASSWORD); [[ -n "$MYSQL_ROOT_PASSWORD" ]] || MYSQL_ROOT_PASSWORD=$(openssl rand -hex 16)
DEV_AUTH_SECRET=$(prev DEV_AUTH_SECRET); [[ -n "$DEV_AUTH_SECRET" ]] || DEV_AUTH_SECRET=$(openssl rand -hex 32)
STORAGE_SIGNING_SECRET=$(prev STORAGE_SIGNING_SECRET); [[ -n "$STORAGE_SIGNING_SECRET" ]] || STORAGE_SIGNING_SECRET=$(openssl rand -hex 32)
cat >> "$TMP/app.env" <<ENV
RUN_MODE=demo
AUTH_ADAPTER=dev
QUEUE_ADAPTER=local
HOST=0.0.0.0
PORT=4000
PUBLIC_WEB_URL=$URL
PUBLIC_API_URL=$URL
DATABASE_URL=mysql://loopscene:$MYSQL_PASSWORD@mysql:3306/loopscene_dev
STORAGE_ADAPTER=local
STORAGE_LOCAL_ROOT=/data/storage
STORAGE_SIGNING_SECRET=$STORAGE_SIGNING_SECRET
DEV_AUTH_SECRET=$DEV_AUTH_SECRET
FEATURE_FREE_TRIAL_ENABLED=true
DEV_LOGIN_ALLOWLIST=$ALLOWLIST
MUSIC_BASE_URL=$MUSIC_URL
MUSIC_ALLOWED_AUDIO_HOSTS=$MUSIC_AUDIO_HOSTS
ENV
# one line per key, last value wins (docker env_file must not see duplicates)
awk -F= '{k=$1; if(!(k in v)) ord[++n]=k; v[k]=$0} END{for(i=1;i<=n;i++) print v[ord[i]]}' "$TMP/app.env" > "$TMP/app.env.d" && mv "$TMP/app.env.d" "$TMP/app.env"
# Where the music service is, FROM INSIDE THIS BOX.
#
# This was carried over from the Mac verbatim, and on the Mac it is the
# office's public address — which is correct there and ECONNREFUSED here: a
# container on the DGX connecting to its own site's public IP does not come
# back in. The first generation after a deploy failed in five seconds with
# upstream_unreachable and submitted_at NULL, and nothing in the deploy had
# said a word. It belongs with DATABASE_URL and PUBLIC_WEB_URL — pinned to
# this machine, not inherited from the one that ran the script.
MUSIC_PORT=$(ssh "$DGX" "sed -n 's/^HOST_PORT=//p' ~/yuha-spark/.env 2>/dev/null" | head -1)
[[ -n "$MUSIC_PORT" ]] || MUSIC_PORT=$(sed -n 's#^MUSIC_BASE_URL=.*:\([0-9][0-9]*\).*#\1#p' "$MUSIC/.env" | tail -1)
[[ -n "$MUSIC_PORT" ]] || MUSIC_PORT=8583
MUSIC_URL="http://$IP:$MUSIC_PORT"
# SEC-05: the worker refuses to pull audio from a host that is not on this
# list, and the service hands back URLs built from its own AUDIO_BASE_URL. If
# that still names the public address, fixing only the line above moves the
# failure from upstream_unreachable to audio_fetch_failed. Both addresses are
# allowed, so whichever the service is configured with, the pull works.
MUSIC_AUDIO_HOSTS="$IP"
PREV_AUDIO_HOST=$(ssh "$DGX" "sed -n 's#^AUDIO_BASE_URL=##p' ~/yuha-spark/.env 2>/dev/null" | sed -E 's#^https?://##; s#[:/].*##' | head -1)
[[ -n "$PREV_AUDIO_HOST" && "$PREV_AUDIO_HOST" != "$IP" ]] && MUSIC_AUDIO_HOSTS="$IP,$PREV_AUDIO_HOST"

STRIPE_SECRET_KEY=$(sed -n 's/^STRIPE_SECRET_KEY=//p' "$MUSIC/.env" | tail -1)
cat > "$TMP/.env" <<ENV
APP_PORT=$APP_PORT
MYSQL_PASSWORD=$MYSQL_PASSWORD
MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD
STRIPE_SECRET_KEY=$STRIPE_SECRET_KEY
ENV

echo "== 3/6 source (your music working tree, tracked files)"
( cd "$MUSIC" && git ls-files -z | COPYFILE_DISABLE=1 tar --null -T - -czf "$TMP/src.tgz" )
ls -lh "$TMP/src.tgz" | awk '{print "   " $5}'

echo "== 4/6 upload"
ssh "$DGX" "mkdir -p $R && chmod 700 $R"
scp -q Dockerfile docker-compose.yml nginx.conf team_account.mjs "$TMP/app.env" "$TMP/.env" "$TMP/src.tgz" "$DGX:yuha-app/"
ssh "$DGX" "cd $R && chmod 600 app.env .env && rm -rf src && mkdir src && tar -xzf src.tgz -C src && rm src.tgz"

echo "== 5/6 build and start (first build takes a few minutes)"
ssh "$DGX" "cd $R && docker compose build api && docker compose up -d mysql && \
  until [ \"\$(docker inspect -f '{{.State.Health.Status}}' \$(docker compose ps -q mysql))\" = healthy ]; do sleep 2; done && \
  docker compose run --rm api pnpm db:migrate && docker compose run --rm api pnpm seed && \
  docker compose run --rm web-assets && docker compose up -d api worker web stripe && \
  docker compose restart web"   # web is unchanged, so `up` leaves it running with the old nginx.conf

echo "== 6/6 shared team account (sign-in limited to: ${ALLOWLIST:-anyone})"
# The dev sign-in has no password, so no account that can sign in keeps the
# admin role: the seeded admin@example.jp is demoted on every deploy (pnpm seed
# re-creates it as admin), and the operator is admin only for the top-up.
# SQL goes over stdin, so its quotes never meet the shell quoting of ssh + sh -c
SQL() { printf '%s;\n' "$1" | ssh "$DGX" "cd $R && docker compose exec -T mysql sh -c 'mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" loopscene_dev' 2>&1 | grep -v 'Using a password' || true"; }
TEAM() { ssh "$DGX" "cd $R && docker compose exec -T -e STEP=$1 -e TEAM_EMAIL=$TEAM_EMAIL -e TEAM_CREDITS=$TEAM_CREDITS -e OPERATOR_EMAIL=$OPERATOR_EMAIL api node -" < team_account.mjs; }
ssh "$DGX" "for i in \$(seq 1 30); do curl -sf http://127.0.0.1:$APP_PORT/v1/auth/config >/dev/null && break; sleep 2; done"
SQL "UPDATE users SET role='user' WHERE email='admin@example.jp'"
TEAM ensure
SQL "UPDATE users SET role='admin' WHERE email='$OPERATOR_EMAIL'"
TEAM topup || { SQL "UPDATE users SET role='user' WHERE email='$OPERATOR_EMAIL'"; exit 1; }
SQL "UPDATE users SET role='user' WHERE email='$OPERATOR_EMAIL'"
sleep 8; ssh "$DGX" "cd $R && docker compose logs --tail 40 stripe | grep -o 'whsec_[A-Za-z0-9]*' | tail -1" > "$TMP/whsec" || true
WH=$(cat "$TMP/whsec"); MAC_WH=$(sed -n 's/^STRIPE_WEBHOOK_SECRET=//p' "$MUSIC/.env" | tail -1)
if [[ -n "$WH" && "$WH" != "$MAC_WH" ]]; then
  echo "!! Stripe forwarder secret differs from STRIPE_WEBHOOK_SECRET — updating it on the DGX"
  ssh "$DGX" "cd $R && sed -i 's/^STRIPE_WEBHOOK_SECRET=.*/STRIPE_WEBHOOK_SECRET=$WH/' app.env && docker compose up -d api"
fi

echo
echo "YUHA is up:   $URL"
echo "Shared login: $TEAM_EMAIL   (dev login: email + the two checkboxes)"
echo "Anyone can also log in with their own work email and gets 2 trial credits."
