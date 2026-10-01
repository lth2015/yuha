#!/usr/bin/env bash
# One-shot: GPU check -> build/deploy -> 30s smoke test. Everything goes to run_all.log.
set -uo pipefail
cd "$(dirname "$0")"
exec > >(tee run_all.log) 2>&1
echo "### 00 check_gpu";   ./00_check_gpu.sh || { echo "### STOP at 00"; exit 1; }
echo "### 01 deploy";      ./01_deploy.sh    || { echo "### STOP at 01"; tail -80 build.log; exit 1; }
echo "### 02 smoke test";  python3 02_acceptance.py --quick || echo "### STOP at 02"
echo "### DONE"
