#!/usr/bin/env bash
# Step 0: find the newest NGC PyTorch tag and verify torch sees the GB10 (Blackwell) GPU.
# Usage: ./00_check_gpu.sh            (auto-detect latest tag)
#        ./00_check_gpu.sh 25.09-py3  (force a tag)
set -euo pipefail
cd "$(dirname "$0")"

echo "== host =="; uname -m; nvidia-smi --query-gpu=name,driver_version --format=csv,noheader || true
docker --version

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  TOKEN=$(curl -fsS "https://nvcr.io/proxy_auth?scope=repository:nvidia/pytorch:pull" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' || true)
  if [[ -n "$TOKEN" ]]; then
    TAG=$(curl -fsS -H "Authorization: Bearer $TOKEN" "https://nvcr.io/v2/nvidia/pytorch/tags/list?n=2000" \
      | python3 -c 'import sys,json,re;t=[x for x in json.load(sys.stdin)["tags"] if re.fullmatch(r"\d\d\.\d\d-py3",x)];print(sorted(t)[-1])' || true)
  fi
  TAG="${TAG:-25.09-py3}"
fi
echo "== using nvcr.io/nvidia/pytorch:$TAG =="

docker run --rm --gpus all "nvcr.io/nvidia/pytorch:$TAG" python -c "
import torch, platform
print('arch      ', platform.machine())
print('torch     ', torch.__version__, 'cuda', torch.version.cuda)
print('available ', torch.cuda.is_available())
print('device    ', torch.cuda.get_device_name(0))
print('capability', torch.cuda.get_device_capability(0))
print('arch_list ', torch.cuda.get_arch_list())
x = torch.randn(2048, 2048, device='cuda', dtype=torch.bfloat16); print('matmul ok ', (x@x).float().abs().mean().item() > 0)
"

# remember the tag for the build
if [[ -f .env ]]; then sed -i "s/^NGC_TAG=.*/NGC_TAG=$TAG/" .env; else echo "NGC_TAG=$TAG" > .env.tag; fi
echo "== OK. NGC_TAG=$TAG saved. Paste everything above back to Claude. =="
