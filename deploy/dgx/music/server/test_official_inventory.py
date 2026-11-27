"""bench_official_inventory: the missing-list for an official BGM batch, against batches whose answer is known."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np

import bench_official_inventory as inv

HEAD = ",".join(inv.COLUMNS)


def full_row(i: str, file: str) -> str:
    return ",".join([i, file, f"Title {i}", "Morning", "lofi", "calm", "vlog", "", "ACE-Step", "1.5@ca1e85f",
                     "42", "\"soft, lo-fi\"", "2026-11-26", ""])


def fake_audio(seconds=90.0, sha="a"):
    return lambda p: {"codec": "pcm_s16le", "sample_rate": 48000, "channels": 2, "bit_depth": 16, "kbps": 1536,
                      "duration_s": seconds, "peak_dbfs": -1.0, "rms_dbfs": -16.0, "clipped_samples": 0,
                      "lead_silence_s": 0.0, "tail_silence_s": 0.5, "silent": False, "bytes": 1, "sha256": sha + p.name}


class Batch:
    def __init__(self, manifest: str | None, masters=(), covers=()):
        self.dir = tempfile.TemporaryDirectory()
        self.path = Path(self.dir.name)
        (self.path / "masters").mkdir()
        (self.path / "covers").mkdir()
        if manifest is not None:
            (self.path / "manifest.csv").write_text(manifest, encoding="utf-8")
        for m in masters:
            (self.path / "masters" / m).write_bytes(b"x")
        for c in covers:
            (self.path / "covers" / c).write_bytes(b"x")

    def __enter__(self):
        return self.path

    def __exit__(self, *a):
        self.dir.cleanup()


class TestReport(unittest.TestCase):
    def test_a_complete_track_is_complete(self):
        with Batch("\n".join([HEAD, full_row("OB01", "a.wav")]), ["a.wav"], ["OB01.png"]) as b:
            rep = inv.build_report(b, inspect=fake_audio())
        t = rep["items"][0]
        self.assertEqual((t["missing"], t["problems"]), ([], []))
        self.assertEqual(rep["complete"], 1)
        self.assertEqual(t["cover"], "covers/OB01.png")
        # one track, not thirty: the batch itself is not complete
        self.assertIn("1 tracks, not 30", rep["batch_problems"])

    def test_lists_every_empty_required_column_and_a_missing_cover(self):
        with Batch("\n".join([HEAD, "OB02,b.wav,,,lofi,,,,,,,,,"]), ["b.wav"]) as b:
            t = inv.build_report(b, inspect=fake_audio())["items"][0]
        self.assertEqual(t["missing"], ["title", "series", "mood", "scenario", "model", "model_version",
                                        "seed", "prompt", "generated_at", "cover file"])

    def test_without_a_manifest_every_master_is_listed_with_everything_unknown(self):
        with Batch(None, ["x.mp3", "y.wav", "notes.txt"]) as b:
            rep = inv.build_report(b, inspect=fake_audio())
        self.assertEqual([t["file"] for t in rep["items"]], ["x.mp3", "y.wav"])  # not the .txt
        self.assertIn("manifest.csv is missing: every descriptive field is unknown", rep["batch_problems"])
        self.assertIn("id", rep["items"][0]["missing"])
        self.assertEqual(rep["complete"], 0)

    def test_the_sheet_and_the_folder_disagreeing_is_reported_both_ways(self):
        manifest = "\n".join([HEAD, full_row("OB01", "a.wav"), full_row("OB01", "gone.wav")])
        with Batch(manifest, ["a.wav", "stray.wav"]) as b:
            rep = inv.build_report(b, inspect=fake_audio())
        self.assertIn("id OB01 is used 2 times", rep["batch_problems"])
        self.assertIn("masters/stray.wav is in the folder but in no manifest row", rep["batch_problems"])
        gone = next(t for t in rep["items"] if t["file"] == "gone.wav")
        self.assertIn("masters/gone.wav does not exist", gone["problems"])

    def test_the_same_audio_twice_is_reported(self):
        manifest = "\n".join([HEAD, full_row("OB01", "a.wav"), full_row("OB02", "b.wav")])
        with Batch(manifest, ["a.wav", "b.wav"]) as b:
            rep = inv.build_report(b, inspect=lambda p: {**fake_audio()(p), "sha256": "same"})
        self.assertIn("identical audio: a.wav, b.wav", rep["batch_problems"])

    def test_a_master_shorter_than_the_preview_is_a_problem(self):
        with Batch("\n".join([HEAD, full_row("OB01", "a.wav")]), ["a.wav"], ["OB01.png"]) as b:
            t = inv.build_report(b, inspect=fake_audio(seconds=30))["items"][0]
        self.assertTrue(any("shorter than the 60 s preview" in p for p in t["problems"]))

    def test_a_column_missing_from_the_header_is_named(self):
        with Batch("id,file,title\nOB01,a.wav,T", ["a.wav"]) as b:
            rep = inv.build_report(b, inspect=fake_audio())
        self.assertTrue(any(p.startswith("manifest.csv has no column(s): series") for p in rep["batch_problems"]))


class TestAnalyse(unittest.TestCase):
    def test_levels_clipping_and_edge_silence(self):
        rate = 1000
        x = np.zeros((5 * rate, 2), dtype=np.float32)
        x[1 * rate:4 * rate] = 0.5  # 1 s silent lead, 1 s silent tail
        x[2 * rate, 0] = 1.0        # one clipped sample
        a = inv.analyse(x, rate)
        self.assertEqual(a["clipped_samples"], 1)
        self.assertEqual(a["peak_dbfs"], 0.0)
        self.assertAlmostEqual(a["lead_silence_s"], 1.0, places=2)
        self.assertAlmostEqual(a["tail_silence_s"], 1.0, places=2)
        self.assertFalse(a["silent"])

    def test_all_silence_is_called_silent(self):
        a = inv.analyse(np.zeros((1000, 2), dtype=np.float32), 1000)
        self.assertTrue(a["silent"])
        self.assertIsNone(a["peak_dbfs"])
        self.assertIn("the whole file is silent", inv.audio_problems({**a, "duration_s": 90}))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg")
class TestRealFile(unittest.TestCase):
    def test_a_real_wav_is_probed_and_decoded(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "t.wav"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
                            "-ar", "48000", "-ac", "2", "-c:a", "pcm_s24le", str(p)], check=True)
            a = inv.inspect_audio(p)
        self.assertEqual((a["sample_rate"], a["channels"], a["bit_depth"]), (48000, 2, 24))
        self.assertAlmostEqual(a["duration_s"], 2.0, places=1)
        self.assertLess(a["peak_dbfs"], 0)
        self.assertEqual(len(a["sha256"]), 64)


if __name__ == "__main__":
    unittest.main()
