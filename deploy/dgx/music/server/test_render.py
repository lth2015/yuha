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


if __name__ == "__main__":
    unittest.main()
