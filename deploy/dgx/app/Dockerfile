# YUHA full stack for the DGX test deployment: api + worker + the built web
# bundle, from one image. (The repo's own Dockerfile is the production
# api/worker image; this one keeps the dev toolchain so migrations and the seed
# can run from it too.)
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* && npm install -g pnpm@11.1.2 && npm cache clean --force
WORKDIR /app
COPY src/ ./
RUN pnpm install --frozen-lockfile
# web: VITE_API_URL unset = same-origin /v1, which nginx proxies to the api.
RUN pnpm build
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/api/dist/index.js"]
