"""/v1/align's choice of what Whisper hears, without GPU models or real audio."""
import os
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

JOB = "0123456789abcdef0123456789abcdef"
LYRICS = "晚风吹过街角\n我等你回来"
# Heard on the stem: the second line's first word smeared back to 8.0s.
STEM_WORDS = [("晚风吹过街角", 1, 4), ("我", 8.0, 10.6), ("等你回来", 10.6, 13)]
MIX_WORDS = [("晚风吹过街角", 1, 4), ("我等你回来", 10.4, 13)]


def fake_separate(stem=True, error=None):
    mod = types.ModuleType("separate")

    def vocal_stem(path):
        if error:
            raise error
        return ("stem-mono", 44100) if stem else None

    mod.vocal_stem = vocal_stem
    # 20ms hops: voiced 1.0–4.0s and 10.2–13.0s, silent elsewhere.
    env = [-80.0] * 1000
    for i in list(range(50, 200)) + list(range(510, 650)):
        env[i] = -20.0
    mod.loudness_envelope = lambda mono, sr: env
    mod.to_16k = lambda mono, sr: "stem-16k"
    mod.status = lambda: {}
    return mod


def fake_forced(coverage=0.9, error=False):
    mod = types.ModuleType("forced")
    mod.calls = []

    def force_align(lyrics, wave, duration, device="cuda"):
        mod.calls.append(wave)
        if error:
            raise RuntimeError("no MMS weights")
        return {"coverage": coverage, "lines": [
            {"text": "晚风吹过街角", "section": "", "start": 1.0, "end": 4.0, "words": []},
            {"text": "我等你回来", "section": "", "start": 10.2, "end": 13.0, "words": []},
        ]}

    mod.force_align = force_align
    return mod


class AlignRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory()
        cls.environment = patch.dict(os.environ, {"DATA_DIR": cls.data.name})
        cls.environment.start()
        import app
        cls.app = app
        (app.AUDIO_DIR / f"{JOB}.mp3").write_bytes(b"not really audio")

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop()
        cls.data.cleanup()

    def run_align(self, separate_mod, heard, forced_mod=None):
        calls = []

        def transcribe(audio, lyrics):
            calls.append(audio)
            return heard(audio)

        body = self.app.AlignRequest(lyrics=LYRICS, audio_url=f"https://x/v1/audio/{JOB}.mp3",
                                     duration_seconds=20)
        # The Whisper path's tests run with forced alignment unable to answer,
        # which is also what an image without its model weights does.
        with patch.dict(sys.modules, {"separate": separate_mod, "forced": forced_mod or fake_forced(error=True)}), \
                patch.object(self.app, "API_KEY", "k"), \
                patch.object(self.app, "transcribe_words", transcribe):
            out = self.app.align(body, authorization="Bearer k")
        return out, calls

    def test_forced_alignment_is_used_when_it_found_the_lyrics(self):
        out, calls = self.run_align(fake_separate(), lambda audio: MIX_WORDS, fake_forced(coverage=0.9))
        self.assertEqual(out["method"], "forced")
        self.assertEqual(out["model"], "mms-fa")
        self.assertEqual(out["heard"], "vocal_stem")
        self.assertEqual(calls, [])  # Whisper was not needed
        self.assertEqual(out["lines"][1]["start"], 10.2)

    def test_forced_alignment_that_found_too_little_falls_back_to_whisper(self):
        out, calls = self.run_align(fake_separate(), lambda audio: STEM_WORDS, fake_forced(coverage=0.3))
        self.assertEqual(out["method"], "whisper")
        self.assertEqual(calls, ["stem-16k"])

    def test_forced_alignment_is_not_tried_without_a_stem(self):
        forced = fake_forced(coverage=0.9)
        out, _ = self.run_align(fake_separate(stem=False), lambda audio: MIX_WORDS, forced)
        self.assertEqual(out["method"], "whisper")
        self.assertEqual(forced.calls, [])

    def test_forced_alignment_that_found_less_than_whisper_needs_is_still_returned(self):
        # Its coverage is its own measure: 0.7 of lettered units found is a
        # pass for forced alignment, not a Whisper coverage of 0.7.
        out, _ = self.run_align(fake_separate(), lambda audio: [], fake_forced(coverage=0.7))
        self.assertEqual(out["method"], "forced")
        self.assertEqual(out["coverage"], 0.7)

    def test_whisper_hears_the_vocal_stem_and_the_voice_corrects_its_clock(self):
        out, calls = self.run_align(fake_separate(), lambda audio: STEM_WORDS)
        self.assertEqual(calls, ["stem-16k"])
        self.assertEqual(out["heard"], "vocal_stem")
        self.assertTrue(out["voice_activity"])
        self.assertAlmostEqual(out["lines"][1]["start"], 10.2, places=2)

    def test_the_mix_is_kept_when_the_stem_heard_less(self):
        heard = lambda audio: STEM_WORDS[:1] if audio == "stem-16k" else MIX_WORDS
        out, calls = self.run_align(fake_separate(), heard)
        self.assertEqual(len(calls), 2)
        self.assertEqual(out["heard"], "mix")
        self.assertEqual(out["coverage"], 1.0)

    def test_a_separation_failure_aligns_on_the_mix_as_before(self):
        out, calls = self.run_align(fake_separate(error=RuntimeError("no weights")), lambda audio: MIX_WORDS)
        self.assertEqual(len(calls), 1)
        self.assertEqual(out["heard"], "mix")
        self.assertFalse(out["voice_activity"])
        self.assertEqual(out["lines"][1]["start"], 10.4)

    def test_a_whisper_failure_on_the_stem_still_tries_the_mix(self):
        def heard(audio):
            if audio == "stem-16k":
                raise RuntimeError("cuda oom")
            return MIX_WORDS
        out, calls = self.run_align(fake_separate(), heard)
        self.assertEqual(out["heard"], "mix")
        self.assertEqual(out["coverage"], 1.0)

    def test_a_stem_with_no_singing_is_not_reported_as_voice_activity(self):
        silent = fake_separate()
        silent.loudness_envelope = lambda mono, sr: [-90.0] * 1000
        out, _ = self.run_align(silent, lambda audio: MIX_WORDS)
        self.assertFalse(out["voice_activity"])


if __name__ == "__main__":
    unittest.main()
