#!/usr/bin/env python3
"""
Acceptance run for 部署需求 §6. Stdlib only; run on the Spark host:
    python3 02_acceptance.py                 # full run (5 durations + vocal + invalid + restart)
    python3 02_acceptance.py --quick         # just one 30s job
Prints a summary table at the end — paste it back.
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
env = dict(l.strip().split("=", 1) for l in open(os.path.join(HERE, ".env")) if "=" in l and not l.startswith("#"))
BASE = env["AUDIO_BASE_URL"]
KEY = env["YUHA_API_KEY"]
H = {"authorization": f"Bearer {KEY}", "content-type": "application/json"}


def req(method, url, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    t0 = time.time()
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, resp.read(), dict(resp.headers), time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers), time.time() - t0


def base_body(dur, instrumental=True):
    b = {"model": "ace-step", "duration_seconds": dur,
         "prompt": "slow lo-fi, soft keys, distant room tone, quiet but not lonely",
         "tempo": "slow", "energy": 0.3, "instruments": ["soft_keys", "vinyl_noise"],
         "style_tags": ["lofi", "ambient"], "format": "mp3", "instrumental": instrumental}
    if not instrumental:
        b["prompt"] = "warm indie pop ballad, gentle female vocal, acoustic guitar, light drums"
        b["style_tags"] = ["pop", "indie"]
        b["instruments"] = ["acoustic_guitar", "soft_drums"]
        b["lyrics"] = ("[verse]\nCity lights are fading slow\nI keep the window open\n"
                       "[chorus]\nStay a little longer here\nLet the night be quiet\n")
    return b


def ffprobe_duration(mp3: bytes) -> float:
    # ffprobe can't get mp3 duration from a pipe (no seeking) -> write to a temp file in the container
    out = subprocess.run(["docker", "exec", "-i", "yuha-music", "sh", "-c",
                          "cat > /tmp/probe.mp3 && ffprobe -v error -show_entries format=duration "
                          "-of default=nw=1:nk=1 /tmp/probe.mp3; rm -f /tmp/probe.mp3"],
                         input=mp3, capture_output=True)
    txt = out.stdout.decode().strip()
    try:
        return float(txt)
    except ValueError:
        return float("nan")


def run_job(dur, instrumental=True):
    code, raw, _, t_submit = req("POST", f"{BASE}/v1/jobs", base_body(dur, instrumental), H)
    assert code == 200, f"submit {code} {raw[:200]}"
    job = json.loads(raw)
    jid, seen = job["id"], [job["status"]]
    t0 = time.time()
    while True:
        time.sleep(3)
        code, raw, _, _ = req("GET", f"{BASE}/v1/jobs/{jid}", headers=H)
        j = json.loads(raw)
        if j["status"] != seen[-1]:
            seen.append(j["status"])
        if j["status"] in ("succeeded", "failed", "rejected"):
            break
        if time.time() - t0 > 3600:
            raise TimeoutError(jid)
    res = {"dur": dur, "vocal": not instrumental, "id": jid, "submit_s": round(t_submit, 2),
           "states": "→".join(seen), "gen_s": j.get("generation_seconds"), "error": j.get("error")}
    if j["status"] == "succeeded":
        code, mp3, hdr, _ = req("GET", j["audio_url"])
        res.update(http=code, ctype=hdr.get("content-type") or hdr.get("Content-Type"),
                   mb=round(len(mp3) / 1e6, 2), audio_s=round(ffprobe_duration(mp3), 1))
        res["dur_ok"] = abs(res["audio_s"] - dur) <= dur * 0.10
        res["rtf"] = round(res["gen_s"] / res["audio_s"], 3) if res["gen_s"] else None
        with open(os.path.join(HERE, "data", f"accept_{dur}s_{'vocal' if not instrumental else 'inst'}.mp3"), "wb") as f:
            f.write(mp3)
    return j, res


def main():
    quick = "--quick" in sys.argv
    print("BASE", BASE)
    print("healthz", req("GET", f"{BASE}/healthz")[1].decode())
    checks, rows = [], []

    # auth
    code, *_ = req("POST", f"{BASE}/v1/jobs", base_body(30), {"content-type": "application/json"})
    checks.append(("no auth → 401", code == 401, code))
    # invalid input
    bad = base_body(30); bad["duration_seconds"] = 999
    code, raw, *_ = req("POST", f"{BASE}/v1/jobs", bad, H)
    checks.append(("duration 999 → 400/422", code in (400, 422), code))
    code, raw, *_ = req("POST", f"{BASE}/v1/jobs", {"prompt": 123}, H)
    checks.append(("garbage body → 400/422", code in (400, 422), code))
    # unknown fields ignored
    extra = base_body(30); extra["some_future_field"] = {"x": 1}
    code, raw, *_ = req("POST", f"{BASE}/v1/jobs", extra, H)
    checks.append(("unknown field accepted", code == 200, code))

    plan = [(30, True)] if quick else [(30, True), (60, True), (120, True), (180, True), (240, True),
                                       (60, False), (180, False)]
    for dur, inst in plan:
        print(f"-- job {dur}s {'instrumental' if inst else 'vocal'} ...", flush=True)
        j, r = run_job(dur, inst)
        rows.append(r)
        print("  ", r, flush=True)

    if not quick:
        pol = subprocess.run(["docker", "inspect", "-f", "{{.HostConfig.RestartPolicy.Name}}", "yuha-music"],
                             capture_output=True, text=True).stdout.strip()
        subprocess.run(["docker", "restart", "yuha-music"], check=True, capture_output=True)
        t0 = time.time(); ok = False
        while time.time() - t0 < 900:
            try:
                h = json.loads(req("GET", f"{BASE}/healthz")[1])
                if h.get("model_loaded"): ok = True; break
            except Exception:
                pass
            time.sleep(5)
        checks.append((f"restart policy={pol}, back after restart", ok and pol in ("always", "unless-stopped"),
                       f"{round(time.time()-t0)}s"))

    print("\n================ SUMMARY (paste this back) ================")
    for name, ok, val in checks:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}  ({val})")
    print(f"{'dur':>4} {'vocal':>5} {'submit_s':>8} {'states':<28} {'gen_s':>7} {'audio_s':>7} {'rtf':>6} {'MB':>5} {'ctype':<11} ok")
    for r in rows:
        print(f"{r['dur']:>4} {str(r['vocal']):>5} {r['submit_s']:>8} {r['states']:<28} {str(r.get('gen_s')):>7} "
              f"{str(r.get('audio_s')):>7} {str(r.get('rtf')):>6} {str(r.get('mb')):>5} {str(r.get('ctype')):<11} "
              f"{r.get('dur_ok')} {r.get('error') or ''}")
    print("mp3 samples saved under data/accept_*.mp3")


if __name__ == "__main__":
    main()
