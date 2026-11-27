"""
The Qwen3-ForcedAligner worker (qwen_align.py starts it). Runs in /opt/qwenv:
one request per line on stdin, {"id", "npy", "text", "language"}; one answer
per line on stdout, {"id", "units": [[text, start, end], ...]} or {"id", "error"}.
The model loads on the first request and stays. Everything a library prints
goes to stderr, so stdout carries answers only.
"""
import json
import os
import sys

out = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
sys.stdout = sys.stderr  # libraries print; the answers must stay parseable

MODEL = os.environ.get("QWEN_ALIGNER_MODEL", "Qwen/Qwen3-ForcedAligner-0.6B")
model = None


def load():
    import torch
    from qwen_asr import Qwen3ForcedAligner
    return Qwen3ForcedAligner.from_pretrained(
        MODEL, dtype=torch.bfloat16, device_map="cuda:0" if torch.cuda.is_available() else "cpu")


for line in sys.stdin:
    try:
        req = json.loads(line)
    except ValueError:
        continue
    try:
        import numpy as np
        if model is None:
            model = load()
        wav = np.load(req["npy"])
        res = model.align(audio=(wav, 16000), text=req["text"], language=req["language"])
        units = [[u.text, float(u.start_time), float(u.end_time)] for u in res[0]]
        out.write(json.dumps({"id": req.get("id"), "units": units}, ensure_ascii=False) + "\n")
    except Exception as e:  # noqa: BLE001 - every failure is an answer, never a dead worker
        out.write(json.dumps({"id": req.get("id"), "error": repr(e)[:300]}) + "\n")
