# YUHA API + worker image.
#
# One image serves both workloads; the Helm chart selects the entry point. That
# keeps the deployed API and worker byte-identical, which matters because they
# share the ledger and state-machine code.

# ---------------------------------------------------------------- build stage
FROM node:22.13.1-bookworm-slim AS build

# pnpm is installed at an exact version rather than through corepack: corepack
# resolves and signature-checks against the registry at build time, which makes
# the image build depend on network state and on the signing keys bundled in the
# base image. A pinned global install is reproducible.
RUN npm install -g pnpm@11.1.2 && npm cache clean --force

WORKDIR /app

# Manifests first, so a source-only change reuses the dependency layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/providers/package.json packages/providers/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/

# --frozen-lockfile: the build fails rather than silently resolving a different
# dependency tree than the one that was tested.
RUN pnpm install --frozen-lockfile --filter "@yuha/contracts..." \
      --filter "@yuha/db..." --filter "@yuha/providers..." \
      --filter "@yuha/api..." --filter "@yuha/worker..."

COPY tsconfig.base.json ./
COPY scripts/ scripts/
COPY packages/ packages/
COPY apps/api/ apps/api/
COPY apps/worker/ apps/worker/

RUN pnpm --filter @yuha/contracts build \
 && pnpm --filter @yuha/db build \
 && pnpm --filter @yuha/providers build \
 && pnpm --filter @yuha/api build \
 && pnpm --filter @yuha/worker build

# `pnpm deploy` produces a self-contained directory with workspace
# dependencies copied in rather than symlinked into a shared store, which is
# what makes the tree survive being copied into a fresh image. `pnpm prune` is
# the wrong tool here: at a workspace root it removes the workspace links
# entirely and the app then cannot resolve @yuha/*.
RUN CI=true pnpm deploy --filter=@yuha/api  --prod --legacy /deploy/api \
 && CI=true pnpm deploy --filter=@yuha/worker --prod --legacy /deploy/worker

# --------------------------------------------------------------- runtime stage
FROM node:22.13.1-bookworm-slim AS runtime

# ffmpeg performs the output checks and the export rendering. The worker refuses
# to start without it, so it is a hard requirement of this image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Runs as a non-root user with no write access to its own code.
RUN groupadd --gid 10001 loopscene \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin loopscene

# Two self-contained trees, one per workload. Both were built from the same
# commit, so the API and the worker still share identical ledger and
# state-machine code.
COPY --from=build --chown=root:root /deploy/api ./api
COPY --from=build --chown=root:root /deploy/worker ./worker

USER loopscene
EXPOSE 4000

# tini reaps the ffmpeg child processes the worker spawns.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "api/dist/index.js"]
