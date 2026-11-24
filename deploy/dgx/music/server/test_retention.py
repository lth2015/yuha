"""Retention on the music server (docs/legal/PRIVACY_CHANGES_2026-11.md): no GPU, no models."""
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch


class RetentionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory()
        cls.environment = patch.dict(os.environ, {"DATA_DIR": cls.data.name})
        cls.environment.start()
        import app
        cls.app = app

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop()
        cls.data.cleanup()

    def job(self, job_id, status, age_days, key=None):
        created = time.time() - age_days * 86400
        self.app.save_job({"id": job_id, "status": status, "created_at": created, "idempotency_key": key, "request": {"lyrics": "secret words"}})
        mp3 = self.app.AUDIO_DIR / f"{job_id}.mp3"
        mp3.write_bytes(b"audio")
        os.utime(mp3, (created, created))
        if key:
            self.app._idem[key] = job_id

    def test_old_finished_jobs_go_with_their_audio_and_new_or_unfinished_ones_stay(self):
        self.job("old1", "succeeded", 40, key="k-old")
        self.job("old2", "failed", 31)
        self.job("new", "succeeded", 5)
        self.job("stuck", "running", 90)
        stray = self.app.AUDIO_DIR / "upload-x.wav"
        stray.write_bytes(b"x")
        then = time.time() - 60 * 86400
        os.utime(stray, (then, then))

        with patch.object(self.app, "RETENTION_DAYS", 30.0):
            self.assertEqual(self.app.purge_old(), 2)

        names = {p.stem for p in self.app.JOBS_DIR.glob("*.json")}
        self.assertEqual(names, {"new", "stuck"})
        self.assertFalse((self.app.AUDIO_DIR / "old1.mp3").exists())
        self.assertFalse((self.app.AUDIO_DIR / "old2.mp3").exists())
        self.assertTrue((self.app.AUDIO_DIR / "new.mp3").exists())
        self.assertFalse(stray.exists())
        self.assertNotIn("k-old", self.app._idem)

    def test_zero_keeps_everything(self):
        self.job("bench", "succeeded", 400)
        with patch.object(self.app, "RETENTION_DAYS", 0.0):
            self.assertEqual(self.app.purge_old(), 0)
        self.assertTrue((self.app.JOBS_DIR / "bench.json").exists())


if __name__ == "__main__":
    unittest.main()
