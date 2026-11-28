"""bench_master: the mastering A/B. The real ffmpeg chain where ffmpeg exists; no GPU, no model."""
import shutil
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

import bench_master as bm
import bench_quality as bq

SR = 44100
SECTIONS = [{"name": "verse", "start": 0.0, "end": 20.0}, {"name": "chorus", "start": 20.0, "end": 40.0},
            {"name": "verse", "start": 40.0, "end": 60.0}, {"name": "chorus", "start": 60.0, "end": 80.0}]


def song(verse_db: float = -26.0, chorus_db: float = -20.0) -> np.ndarray:
    """A pulsing two-tone band with noise; choruses 6 dB above verses."""
    rng = np.random.default_rng(0)
    parts = []
    for s in SECTIONS:
        t = np.arange(int((s["end"] - s["start"]) * SR)) / SR
        x = 0.3 * np.sin(2 * np.pi * 220 * t) + 0.2 * np.sin(2 * np.pi * 330 * t) + 0.1 * rng.normal(0, 1, t.size)
        x *= 0.6 + 0.4 * (np.sin(2 * np.pi * 2 * t) > 0)
        db = chorus_db if s["name"] == "chorus" else verse_db
        parts.append(x / np.sqrt(np.mean(x ** 2)) * 10 ** (db / 20))
    return np.concatenate(parts)


def write_wav(path: Path, y: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(y, -1, 1) * 32767).astype("<i2").tobytes())


def decode(path: Path) -> np.ndarray:
    import subprocess
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "-ac", "1", "-ar", str(SR), "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, "<i2").astype(np.float64) / 32768


class ChorusLift(unittest.TestCase):
    def test_reads_the_level_difference_and_ignores_short_sections(self):
        self.assertAlmostEqual(bm.chorus_lift(song(), SR, SECTIONS), 6.0, delta=0.3)
        blip = SECTIONS + [{"name": "chorus", "start": 80.0, "end": 81.0}]
        self.assertAlmostEqual(bm.chorus_lift(song(), SR, blip), 6.0, delta=0.3)
        self.assertIsNone(bm.chorus_lift(song(), SR, [s for s in SECTIONS if s["name"] == "verse"]))


class Summary(unittest.TestCase):
    def test_pairs_each_song_with_itself_and_counts_the_reference_band(self):
        rows = {f"s{i}": {"current": {"chorus_lift_db": 0.5, "lra": 3.0, "lufs": -14.0, "true_peak_db": -2.5,
                                      "intelligibility": 0.8},
                          "linear": {"chorus_lift_db": 2.0, "lra": 4.5, "lufs": -14.1, "true_peak_db": -2.6,
                                     "intelligibility": 0.8}} for i in range(6)}
        rows["broken"] = {"error": "boom"}
        s = bm.summarise(rows)
        self.assertEqual(s["songs"], 6)
        lift = s["measures"]["chorus_lift_db"]
        self.assertEqual((lift["current"], lift["linear"], lift["delta"]), (0.5, 2.0, 1.5))
        self.assertEqual((lift["b_higher"], lift["b_lower"]), (6, 0))
        self.assertEqual((lift["in_band_current"], lift["in_band_linear"], lift["n_with_band"]), (0, 6, 6))
        self.assertEqual(s["measures"]["intelligibility"]["b_higher"], 0)
        self.assertIn("副歌比主歌", bm.page(s))


@unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
class BothArmsFromOneWav(unittest.TestCase):
    def test_the_linear_arm_keeps_more_of_the_chorus_at_the_same_loudness_and_ceiling(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            write_wav(d / "raw.wav", song())
            arms = bm.make_arms(d / "raw.wav", d, "x", 80.0, tone="conservative", fade_in_ms=30, fade_out_ms=1500,
                                master_tp=-2.5, master_lra=11, lufs_of=lambda p: bq.ebur128(p).get("lufs"))
            got = {a: {**bq.ebur128(Path(arms[a]["audio"])),
                       "lift": bm.chorus_lift(decode(Path(arms[a]["audio"])), SR, SECTIONS)} for a in bm.ARMS}
            self.assertFalse(any(p.name.startswith(".") for p in (d / "linear").iterdir()))
        # Today's chain flattens the chorus; the linear one keeps clearly more of it.
        self.assertLess(got["current"]["lift"], 3.5)
        self.assertGreater(got["linear"]["lift"], got["current"]["lift"] + 1.0)
        # Same delivery loudness and ceiling.
        self.assertAlmostEqual(got["linear"]["lufs"], -14.0, delta=0.4)
        self.assertAlmostEqual(got["current"]["lufs"], -14.0, delta=0.6)
        self.assertLessEqual(got["linear"]["true_peak_db"], -2.0)


if __name__ == "__main__":
    unittest.main()
