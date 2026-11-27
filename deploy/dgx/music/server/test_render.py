"""Rendering contract checks without loading GPU models or private audio."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


class RenderOutputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory()
        cls.environment = patch.dict(os.environ, {"DATA_DIR": cls.data.name})
        cls.environment.start()
        import app
        cls.service = app

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop()
        cls.data.cleanup()

    def test_missing_render_never_substitutes_an_older_song(self):
        class NoOutput:
            def __call__(self, **kwargs):
                return []

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "outputs").mkdir()
            (root / "outputs" / "old-song.wav").write_bytes(b"previous song")
            work = root / "job"
            work.mkdir()
            (work / "take-1.wav").write_bytes(b"previous take")
            previous_cwd = Path.cwd()
            try:
                os.chdir(root)
                with patch.object(self.service, "_pipeline", NoOutput()):
                    with self.assertRaisesRegex(RuntimeError, "no wav file"):
                        self.service.render({"duration_seconds": 30, "mode": "vocal", "lyrics": "Stay with me", "prompt": "gentle pop"}, work, seed=2, engine="v1")
            finally:
                os.chdir(previous_cwd)

    def test_repeated_seed_cannot_reuse_a_previous_render(self):
        class WritesOnce:
            calls = 0

            def __call__(self, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    Path(kwargs["save_path"]).write_bytes(b"first render")
                return []

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(self.service, "_pipeline", WritesOnce()):
                request = {"duration_seconds": 30, "lyrics": "Stay with me", "prompt": "gentle pop"}
                first = self.service.render(request, Path(directory), seed=7, engine="v1")
                self.assertEqual(first.read_bytes(), b"first render")
                with self.assertRaisesRegex(RuntimeError, "no wav file"):
                    self.service.render(request, Path(directory), seed=7, engine="v1")

    def test_explicit_current_output_is_accepted_but_external_old_output_is_not(self):
        class NamedOutput:
            def __call__(self, **kwargs):
                path = Path(kwargs["save_path"]).with_name("model-renamed.wav")
                path.write_bytes(b"current render")
                return [str(path), "metadata.json"]

        with tempfile.TemporaryDirectory() as directory:
            request = {"duration_seconds": 30, "lyrics": "Stay with me", "prompt": "gentle pop"}
            with patch.object(self.service, "_pipeline", NamedOutput()):
                current = self.service.render(request, Path(directory), engine="v1")
                self.assertEqual(current.read_bytes(), b"current render")

            class OldOutput:
                def __call__(self, **kwargs):
                    return [str(current)]

            with patch.object(self.service, "_pipeline", OldOutput()):
                with self.assertRaisesRegex(RuntimeError, "no wav file"):
                    self.service.render(request, Path(directory), engine="v1")


class RenderReportTests(unittest.TestCase):
    """The report a finished job carries back to YUHA (quality.py; BGM B2)."""

    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory()
        cls.environment = patch.dict(os.environ, {"DATA_DIR": cls.data.name})
        cls.environment.start()
        import app
        cls.service = app

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop()
        cls.data.cleanup()

    def _wav(self, directory: Path, expr: str) -> Path:
        import subprocess
        path = directory / "take.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
                        f"aevalsrc={expr}|{expr}:s=48000:d=2", "-c:a", "pcm_f32le", str(path)], check=True)
        return path

    def _job(self, request: dict, wav: Path) -> dict:
        job = {"id": "report-test", "request": request, "status": "running", "created_at": 0.0}
        self.service.AUDIO_DIR.mkdir(parents=True, exist_ok=True)
        with patch.object(self.service, "render", lambda *a, **k: wav), \
             patch.object(self.service, "_master", lambda src, dst, want_seconds: dst.write_bytes(b"mp3") and {}), \
             patch.object(self.service, "_probe_seconds", lambda p: 2.0), \
             patch.object(self.service, "_stem_locked", lambda p: None):
            self.service.run_generation(job)
        return job

    def test_an_instrumental_take_reports_model_time_and_clipping(self):
        with tempfile.TemporaryDirectory() as d:
            wav = self._wav(Path(d), "0.5*sin(2*PI*220*t)")
            job = self._job({"duration_seconds": 30, "instrumental": True, "prompt": "calm"}, wav)
        report = job["report"]
        self.assertEqual(report["engine"], self.service.ENGINE)
        self.assertTrue(report["model"].startswith("ace-step"))
        self.assertGreaterEqual(report["render_seconds"], 0)
        self.assertEqual(report["clipped_ratio"], 0.0)
        self.assertAlmostEqual(report["peak_dbfs"], -6.0, delta=0.2)
        self.assertIsNone(report["vocal_ratio"])  # the separator was unavailable: not measured, not zero
        self.assertEqual(self.service.public_view({**job, "status": "succeeded"})["report"], report)

    def test_a_squared_off_take_reports_its_clipping(self):
        with tempfile.TemporaryDirectory() as d:
            wav = self._wav(Path(d), "max(-1\\,min(1\\,2*sin(2*PI*220*t)))")
            job = self._job({"duration_seconds": 30, "instrumental": True, "prompt": "calm"}, wav)
        self.assertGreater(job["report"]["clipped_ratio"], 0.3)

    def test_a_failed_measurement_still_delivers(self):
        with tempfile.TemporaryDirectory() as d:
            wav = Path(d) / "not-audio.wav"
            wav.write_bytes(b"not audio")
            job = self._job({"duration_seconds": 30, "instrumental": True, "prompt": "calm"}, wav)
        self.assertIn("error", job["report"])
        self.assertEqual(job["audio_bytes"], 3)


if __name__ == "__main__":
    unittest.main()
