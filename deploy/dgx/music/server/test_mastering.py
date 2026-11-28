import unittest

from mastering import build_filters, build_linear_filters, fit_gain, validate_tone


class MasteringFilterTests(unittest.TestCase):
    def test_conservative_tone_precedes_loudness_and_fades(self):
        filters = build_filters(
            tone="conservative", lufs=-14, true_peak=-2.5, lra=11,
            fade_in_ms=30, fade_out_ms=1500, want_seconds=30,
        )
        self.assertEqual(filters[:5], [
            "highpass=f=28:p=2", "lowpass=f=18000:p=2",
            "equalizer=f=190:t=q:w=1.1:g=0.8",
            "equalizer=f=3000:t=q:w=1.2:g=-1.25",
            "acompressor=threshold=-18dB:ratio=1.25:attack=20:release=180:makeup=1",
        ])
        self.assertEqual(filters[5:], [
            "loudnorm=I=-14:TP=-2.5:LRA=11",
            "afade=t=in:st=0:d=0.030", "afade=t=out:st=28.500:d=1.500",
        ])

    def test_tone_off_keeps_loudness_and_fades(self):
        self.assertEqual(build_filters(
            tone="off", lufs=-14, true_peak=-2.5, lra=11,
            fade_in_ms=0, fade_out_ms=0, want_seconds=30,
        ), ["loudnorm=I=-14:TP=-2.5:LRA=11"])

    def test_invalid_tone_is_rejected_before_work_is_queued(self):
        with self.assertRaises(ValueError):
            validate_tone("warm-and-loud")


class LinearMasterTests(unittest.TestCase):
    def test_same_tone_and_fades_with_gain_and_limiter_in_place_of_loudnorm(self):
        current = build_filters(tone="conservative", lufs=-14, true_peak=-2.5, lra=11,
                                fade_in_ms=30, fade_out_ms=1500, want_seconds=30)
        linear = build_linear_filters(tone="conservative", gain_db=8.4, ceiling_db=-3.0,
                                      fade_in_ms=30, fade_out_ms=1500, want_seconds=30)
        self.assertEqual(linear[:5], current[:5])
        self.assertEqual(linear[-2:], current[-2:])
        self.assertEqual(linear[5:7], ["volume=8.40dB", "alimiter=limit=0.7079:attack=5:release=50:level=false"])
        self.assertFalse(any(f.startswith("loudnorm") for f in linear))

    def test_gain_is_corrected_by_what_the_limiter_took(self):
        # A limiter that costs 0.6 LU once the gain passes 6 dB.
        lufs = lambda g: -22.4 + g - (0.6 if g > 6 else 0.0)  # noqa: E731
        g = fit_gain(lufs, -14.0, start=8.4)
        self.assertAlmostEqual(lufs(g), -14.0, places=6)

    def test_an_unmeasurable_pass_keeps_the_last_gain(self):
        self.assertEqual(fit_gain(lambda g: None, -14.0, start=3.0), 3.0)


if __name__ == "__main__":
    unittest.main()
