"""The clip service's rules, on the fake backend: no GPU, no weights. Needs ffmpeg."""
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

_DATA = tempfile.TemporaryDirectory()
os.environ.update({"DATA_DIR": _DATA.name, "VIDEO_BACKEND": "fake", "YUHA_API_KEY": "k", "MAX_QUEUE": "3"})

import app  # noqa: E402
import backends  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

AUTH = {"authorization": "Bearer k"}
BODY = {"prompt": "rain on a neon street, slow dolly", "width": 256, "height": 448, "seconds": 1, "fps": 8, "steps": 2}


class ClipServiceTests(unittest.TestCase):
    def setUp(self):
        self.dirs = tempfile.TemporaryDirectory()
        root = Path(self.dirs.name)
        (root / "jobs").mkdir()
        (root / "clips").mkdir()
        self.patches = [
            patch.object(app, "JOBS_DIR", root / "jobs"),
            patch.object(app, "CLIPS_DIR", root / "clips"),
            patch.object(app, "backend", backends.FakeBackend()),
            patch.object(app, "_idem", {}),
            patch.object(app, "_q", app.queue.Queue()),
        ]
        for p in self.patches:
            p.start()
        self.client = TestClient(app.app)  # not entered: no startup, no worker thread

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.dirs.cleanup()

    def submit(self, **over):
        return self.client.post("/v1/clips", json={**BODY, **over}, headers=AUTH)

    def drain(self):
        while not app._q.empty():
            app.run_one(app._q.get())

    def test_a_clip_is_made_silent_and_fetched_by_a_signed_link_only(self):
        res = self.submit()
        self.assertEqual(res.status_code, 202)
        job_id = res.json()["id"]
        self.assertEqual(res.json()["status"], "queued")
        self.assertEqual(res.json()["frames"], 9)  # 8 frames asked: LTX takes 8k+1
        self.drain()
        view = self.client.get(f"/v1/clips/{job_id}", headers=AUTH).json()
        self.assertEqual(view["status"], "succeeded")
        self.assertGreater(view["clip_seconds"], 0)
        self.assertEqual(app.probe(app.CLIPS_DIR / f"{job_id}.mp4")["audio"], 0)
        url = view["clip_url"].replace(app.CLIP_BASE_URL, "")
        self.assertEqual(self.client.get(url).status_code, 200)
        self.assertEqual(self.client.get(url.replace("sig=", "sig=0")).status_code, 403)
        self.assertEqual(self.client.get(f"/v1/clips/{job_id}").status_code, 401)

    def test_the_prompt_is_kept_only_while_the_clip_waits_or_draws(self):
        job_id = self.submit().json()["id"]
        stored = json.loads((app.JOBS_DIR / f"{job_id}.json").read_text())
        self.assertIn("neon", stored["request"]["prompt"])
        with self.assertLogs("yuha-video", level="INFO") as logs:
            self.drain()
        self.assertNotIn("neon", (app.JOBS_DIR / f"{job_id}.json").read_text())
        self.assertFalse(any("neon" in line for line in logs.output))

    def test_a_bad_request_is_refused_without_echoing_it(self):
        res = self.submit(width=250)
        self.assertEqual((res.status_code, res.json()["error"]), (422, "invalid_size"))
        res = self.submit(seconds=60)
        self.assertEqual((res.status_code, res.json()["error"]), (422, "too_long"))
        res = self.client.post("/v1/clips", json={**BODY, "prompt": "secret words", "extra": 1}, headers=AUTH)
        self.assertEqual(res.status_code, 422)
        self.assertNotIn("secret words", res.text)

    def test_the_queue_is_bounded_and_a_repeat_is_the_same_clip(self):
        first = self.submit()
        again = self.client.post("/v1/clips", json=BODY, headers={**AUTH, "idempotency-key": "a"})
        repeat = self.client.post("/v1/clips", json=BODY, headers={**AUTH, "idempotency-key": "a"})
        self.assertEqual(again.json()["id"], repeat.json()["id"])
        self.assertEqual(self.submit().status_code, 202)
        full = self.submit()
        self.assertEqual((full.status_code, full.json()["error"]), (429, "queue_full"))
        self.assertEqual(self.client.get(f"/v1/clips/{first.json()['id']}", headers=AUTH).json()["queue_position"], 0)
        self.drain()
        self.assertEqual(self.submit().status_code, 202)

    def test_a_queued_cancel_is_immediate_and_nothing_is_drawn(self):
        job_id = self.submit().json()["id"]
        res = self.client.post(f"/v1/clips/{job_id}/cancel", headers=AUTH)
        self.assertEqual(res.json()["status"], "cancelled")
        self.drain()
        self.assertEqual(self.client.get(f"/v1/clips/{job_id}", headers=AUTH).json()["status"], "cancelled")
        self.assertFalse((app.CLIPS_DIR / f"{job_id}.mp4").exists())

    def test_a_running_cancel_stops_between_steps_and_leaves_no_file(self):
        app.backend = backends.FakeBackend(delay=5)
        job_id = self.submit().json()["id"]
        t = threading.Thread(target=self.drain)
        t.start()
        for _ in range(100):
            if app.load_job(job_id)["status"] == "running":
                break
            time.sleep(0.02)
        self.assertEqual(self.client.post(f"/v1/clips/{job_id}/cancel", headers=AUTH).json()["cancel_requested"], True)
        t.join(timeout=3)
        self.assertFalse(t.is_alive(), "the cancel did not stop the clip")
        self.assertEqual(app.load_job(job_id)["status"], "cancelled")
        self.assertFalse((app.CLIPS_DIR / f"{job_id}.mp4").exists())

    def test_a_clip_with_sound_is_refused(self):
        class Noisy(backends.FakeBackend):
            def render(self, req, out, should_stop):
                import subprocess
                subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=256x448:rate=8",
                                "-f", "lavfi", "-i", "sine", "-t", "1", "-pix_fmt", "yuv420p", str(out)], check=True)
                return backends.ClipResult(1.0, None, "noisy")
        app.backend = Noisy()
        job_id = self.submit().json()["id"]
        self.drain()
        job = app.load_job(job_id)
        self.assertEqual((job["status"], job["error"]), ("failed", "clip_has_audio"))
        self.assertFalse((app.CLIPS_DIR / f"{job_id}.mp4").exists())

    def test_out_of_memory_is_named(self):
        class Oom(backends.FakeBackend):
            def render(self, req, out, should_stop):
                raise RuntimeError("CUDA out of memory. Tried to allocate 2 GiB")
        app.backend = Oom()
        job_id = self.submit().json()["id"]
        self.drain()
        self.assertEqual(app.load_job(job_id)["error"], "out_of_memory")

    def test_a_restart_requeues_waiting_clips_and_gives_up_on_one_cut_off_twice(self):
        waiting = self.submit().json()["id"]
        cut = self.submit().json()["id"]
        job = app.load_job(cut)
        job.update(status="running", attempts=2)
        app.save_job(job)
        app._q = app.queue.Queue()
        app.recover_jobs()
        self.assertEqual(app._q.qsize(), 1)
        self.assertEqual(app.load_job(cut)["error"], "interrupted")
        self.drain()
        self.assertEqual(app.load_job(waiting)["status"], "succeeded")

    def test_old_finished_clips_go_and_open_ones_stay(self):
        old = self.submit().json()["id"]
        self.drain()
        waiting = self.submit().json()["id"]
        for job_id in (old, waiting):
            job = app.load_job(job_id)
            job["created_at"] -= 72 * 3600
            app.save_job(job)
        self.assertEqual(app.purge_old(), 1)
        self.assertIsNone(app.load_job(old))
        self.assertFalse((app.CLIPS_DIR / f"{old}.mp4").exists())
        self.assertIsNotNone(app.load_job(waiting))


    def test_a_backend_message_is_not_kept_it_may_quote_the_prompt(self):
        class Chatty(backends.FakeBackend):
            def render(self, req, out, should_stop):
                raise RuntimeError(f"bad input: {req.prompt}")
        app.backend = Chatty()
        job_id = self.submit().json()["id"]
        with self.assertLogs("yuha-video", level="INFO") as logs:
            self.drain()
        self.assertEqual(app.load_job(job_id)["error"], "RuntimeError")
        self.assertFalse(any("neon" in line for line in logs.output))

    def test_the_queue_keeps_moving_after_an_internal_error(self):
        first = self.submit().json()["id"]
        second = self.submit().json()["id"]
        stop = "stop"
        app._q.put(stop)
        real_run = app.run_one

        def run(job_id):
            if job_id == stop:
                raise SystemExit  # ends the worker loop for the test
            if job_id == first:
                # Fails where run_one has no handler of its own: the last write of the job.
                with patch.object(app, "_finish", side_effect=OSError("disk full")):
                    return real_run(job_id)
            return real_run(job_id)

        with patch.object(app, "run_one", run), self.assertRaises(SystemExit):
            app.worker()
        self.assertEqual((app.load_job(first)["status"], app.load_job(first)["error"]), ("failed", "internal"))
        self.assertEqual(app.load_job(second)["status"], "succeeded")

    def test_a_reused_key_for_a_different_clip_is_refused(self):
        h = {**AUTH, "idempotency-key": "same"}
        self.assertEqual(self.client.post("/v1/clips", json=BODY, headers=h).status_code, 202)
        res = self.client.post("/v1/clips", json={**BODY, "seed": 7}, headers=h)
        self.assertEqual((res.status_code, res.json()["error"]), (409, "idempotency_key_reused"))

    def test_a_garbled_signature_is_refused_not_an_error(self):
        job_id = self.submit().json()["id"]
        self.drain()
        res = self.client.get(f"/v1/files/{job_id}.mp4", params={"exp": 9999999999, "sig": "é"})
        self.assertEqual(res.status_code, 403)


class FramesTests(unittest.TestCase):
    def test_frames_are_eight_k_plus_one_at_or_above_the_ask(self):
        self.assertEqual(backends.frames_for(4, 24, 8), 97)
        self.assertEqual(backends.frames_for(8, 24, 8), 193)
        self.assertEqual(backends.frames_for(1 / 24, 24, 8), 9)


if __name__ == "__main__":
    unittest.main()
