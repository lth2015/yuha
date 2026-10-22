import unittest

from mastering import build_filters, validate_tone


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


if __name__ == "__main__":
    unittest.main()
