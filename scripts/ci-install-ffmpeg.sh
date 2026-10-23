#!/usr/bin/env bash
# Puts ffmpeg (and ffprobe) on PATH for a GitHub Actions job.
#
# Three ways have been tried, and each failed once on its own:
#   - apt-get: 19 and 24 minutes in one run (Ubuntu mirrors); both jobs hit
#     their time limits before a test ran.
#   - FedericoCarboni/setup-ffmpeg: scrapes the latest version from a third
#     party's README, and "Failed to read version from readme" failed the job.
# So: a static build from GitHub Releases first (the same infrastructure the
# job already depends on), apt only if that is unavailable, and a time limit
# on the step in the workflow so a slow mirror fails in minutes, not twenty.
set -euo pipefail

if command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg already present: $(ffmpeg -version | head -1)"
  exit 0
fi

url="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
dest="${RUNNER_TEMP:-/tmp}/ffmpeg"
if curl -fsSL --retry 3 --retry-delay 5 --max-time 240 "$url" -o "$dest.tar.xz"; then
  mkdir -p "$dest"
  tar -xJf "$dest.tar.xz" -C "$dest" --strip-components=1
  echo "$dest/bin" >> "${GITHUB_PATH:-/dev/null}"
  export PATH="$dest/bin:$PATH"
else
  echo "static build unavailable; falling back to apt"
  sudo apt-get -o Acquire::Retries=3 update
  sudo apt-get install -y --no-install-recommends ffmpeg
fi
ffmpeg -version | head -1
ffprobe -version | head -1
