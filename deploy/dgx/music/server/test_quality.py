"""What the render report says about a take, on synthetic signals (no GPU, no model)."""
import unittest

import numpy as np

from quality import clipping, measure, vocal_presence

SR = 48000


def tone(seconds: float, amp: float, freq: float = 220.0) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


class ClippingTests(unittest.TestCase):
    def test_a_clean_take_is_not_clipped(self):
        r = clipping(np.stack([tone(2, 0.5), tone(2, 0.5)]))
        self.assertAlmostEqual(r["peak_dbfs"], -6.02, places=1)
        self.assertEqual(r["clipped_ratio"], 0.0)

    def test_a_take_squared_off_at_full_scale_is(self):
        squared = np.clip(tone(2, 2.0), -1.0, 1.0)
        r = clipping(np.stack([squared, squared]))
        self.assertAlmostEqual(r["peak_dbfs"], 0.0, places=2)
        self.assertGreater(r["clipped_ratio"], 0.3)

    def test_one_sample_touching_full_scale_is_a_peak_not_clipping(self):
        x = tone(2, 0.4)
        x[1000] = 1.0
        self.assertEqual(clipping(x[None])["clipped_ratio"], 0.0)

    def test_overs_in_a_float_render_are_not_clipped(self):
        # A float WAV can go past 1.0 without losing the waveform; mastering lowers it intact.
        self.assertEqual(clipping(tone(2, 1.6)[None])["clipped_ratio"], 0.0)

    def test_flat_tops_below_full_scale_are_a_limiter_not_clipping(self):
        limited = np.clip(tone(2, 1.0), -0.5, 0.5)
        self.assertEqual(clipping(limited[None])["clipped_ratio"], 0.0)

    def test_silence_reports_no_peak_and_no_clipping(self):
        r = clipping(np.zeros((2, SR), dtype=np.float32))
        self.assertIsNone(r["peak_dbfs"])
        self.assertEqual(r["clipped_ratio"], 0.0)


class VocalPresenceTests(unittest.TestCase):
    def test_no_vocal_stem_energy_is_no_singing(self):
        mix = tone(4, 0.5)
        r = vocal_presence(np.zeros_like(mix), mix, SR)
        self.assertEqual(r["vocal_ratio"], 0.0)
        self.assertEqual(r["vocal_seconds"], 0.0)

    def test_a_voice_for_half_the_take_is_counted_in_seconds(self):
        band = tone(4, 0.3, 110.0)
        voice = np.concatenate([np.zeros(SR * 2, dtype=np.float32), tone(2, 0.4, 440.0)])
        r = vocal_presence(voice, band + voice, SR)
        self.assertAlmostEqual(r["vocal_seconds"], 2.0, delta=0.5)
        self.assertGreater(r["vocal_ratio"], 0.2)

    def test_separation_leakage_under_the_band_is_not_singing(self):
        band = tone(4, 0.5, 110.0)
        leak = tone(4, 0.01, 440.0)  # about -40 dBFS of bleed, everywhere
        r = vocal_presence(leak, band + leak, SR)
        self.assertEqual(r["vocal_seconds"], 0.0)
        self.assertLess(r["vocal_ratio"], 0.01)


class MeasureTests(unittest.TestCase):
    def test_an_instrumental_take_reports_its_vocal_stem(self):
        mix = np.stack([tone(2, 0.5), tone(2, 0.5)])
        voice = tone(2, 0.4, 440.0)
        r = measure("x.wav", instrumental=True, decode=lambda p: (mix, SR), stem=lambda p: (voice, SR))
        self.assertGreater(r["vocal_seconds"], 1.0)
        self.assertEqual(r["clipped_ratio"], 0.0)

    def test_no_separation_is_not_measured_rather_than_no_voice(self):
        mix = np.stack([tone(2, 0.5)])
        r = measure("x.wav", instrumental=True, decode=lambda p: (mix, SR), stem=lambda p: None)
        self.assertIsNone(r["vocal_ratio"])
        self.assertIsNone(r["vocal_seconds"])

    def test_a_sung_take_is_not_separated_at_all(self):
        called = []
        mix = np.stack([tone(2, 0.5)])
        r = measure("x.wav", instrumental=False, decode=lambda p: (mix, SR), stem=lambda p: called.append(p))
        self.assertEqual(called, [])
        self.assertIsNone(r["vocal_seconds"])

    def test_a_stem_at_another_rate_is_compared_at_the_render_rate(self):
        mix = np.stack([tone(4, 0.3, 110.0)])
        voice44 = np.concatenate([np.zeros(44100 * 2, dtype=np.float32), (0.4 * np.sin(2 * np.pi * 440 * np.arange(44100 * 2) / 44100)).astype(np.float32)])
        r = measure("x.wav", instrumental=True, decode=lambda p: (mix, SR), stem=lambda p: (voice44, 44100))
        self.assertAlmostEqual(r["vocal_seconds"], 2.0, delta=0.5)


if __name__ == "__main__":
    unittest.main()
