"""bench_production: the production A/B benchmark, end to end with a fake renderer (no GPU, no ffmpeg)."""
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import bench_production as bp

SECTION_LINE = re.compile(r"^\s*\[.*\]\s*$")


def sung(lyrics: str) -> list[str]:
    return [l for l in lyrics.splitlines() if l.strip() and not SECTION_LINE.match(l)]


class Fake:
    """Writes a few bytes per render and remembers what it was asked."""

    def __init__(self, fail_once=(), coverage=0.9, transcript="la la"):
        self.calls = []
        self.fail_once = set(fail_once)
        self.cov = coverage
        self.heard = transcript

    def tools(self, build_tags=None):
        def render(req, work, seed, tag_style):
            key = (req["prompt"], req.get("lyrics"), seed)
            self.calls.append({"request": req, "seed": seed, "tag_style": tag_style})
            if key in self.fail_once:
                self.fail_once.discard(key)
                raise RuntimeError("ACE-Step returned no wav file")
            work.mkdir(parents=True, exist_ok=True)
            wav = work / "take.wav"
            wav.write_bytes(f"{req['prompt']}|{seed}".encode())
            return wav

        def master(wav, mp3):
            mp3.parent.mkdir(parents=True, exist_ok=True)
            mp3.write_bytes(wav.read_bytes())
            return {"polish": True}

        def coverage(wav, lyrics):
            if self.cov is None:
                raise RuntimeError("whisper down")
            return self.cov

        def gain_copy(src, dst, db):
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(src.read_bytes() + f"|{db}".encode())

        recorded = {json.dumps(e["request"], sort_keys=True): e["expected_tags_v2"] for e in bp.load_manifest()["entries"]}
        return bp.Tools(
            render=render, master=master,
            inspect=lambda p: {"duration_s": 119.8, "lead_silence_s": 0.1, "tail_silence_s": 0.0,
                               "clipped_samples": 0, "peak_dbfs": -1.0, "silent": False},
            coverage=coverage, transcript=lambda wav, lyrics: self.heard,
            loudness=lambda p: -14.0, gain_copy=gain_copy,
            build_tags=build_tags or (lambda r: recorded[json.dumps(r, sort_keys=True)]),
            environment={"engine": "fake"},
        )


class Manifest(unittest.TestCase):
    """The committed input: what is rendered is fixed before anything renders."""

    @classmethod
    def setUpClass(cls):
        cls.m = bp.load_manifest()

    def test_six_briefs_two_seeds_two_arms(self):
        self.assertEqual(len(self.m["entries"]), 24)
        ps = bp.pairs(self.m)
        self.assertEqual(len(ps), 12)
        self.assertEqual({e["language"] for e in self.m["entries"]}, {"zh", "ja", "en"})
        self.assertEqual({e["template"] for e in self.m["entries"]}, {"pop", "ballad"})

    def test_b_differs_from_a_only_in_prompt_and_lyrics_and_sings_the_same_lines(self):
        for p in bp.pairs(self.m):
            a, b = p["A"]["request"], p["B"]["request"]
            self.assertEqual(p["A"]["seed"], p["B"]["seed"])
            for k in set(a) | set(b):
                if k not in ("prompt", "lyrics"):
                    self.assertEqual(a.get(k), b.get(k), f"{p['brief']}: {k}")
            self.assertEqual(sung(a["lyrics"]), sung(b["lyrics"]), p["brief"])
            self.assertNotEqual(a["prompt"], b["prompt"])


class Parity(unittest.TestCase):
    """The tag string the compiler recorded is the one this service builds."""

    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.TemporaryDirectory()
        cls.env = patch.dict(os.environ, {"DATA_DIR": cls.data.name})
        cls.env.start()
        import app
        cls.app = app

    @classmethod
    def tearDownClass(cls):
        cls.env.stop()
        cls.data.cleanup()

    def test_every_request_builds_the_recorded_tags(self):
        self.assertEqual(bp.parity_problems(bp.load_manifest(), self.app.build_tags_v2), [])

    def test_every_production_phrase_reaches_the_engine(self):
        m = bp.load_manifest()
        for brief, info in m["plans"].items():
            for e in m["entries"]:
                if e["brief"] == brief and e["arm"] == "B":
                    tags = self.app.build_tags_v2(e["request"]).split(", ")
                    for phrase in info["report"]["productionPhrases"]:
                        self.assertIn(phrase, tags, e["id"])


class Run(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.out = Path(self.dir.name)
        self.m = bp.load_manifest()

    def tearDown(self):
        self.dir.cleanup()

    def test_renders_every_entry_at_its_own_seed_with_the_v2_builder(self):
        fake = Fake()
        results = bp.run(self.m, self.out, fake.tools(), log=lambda *_: None)
        self.assertEqual(len(fake.calls), 24)
        self.assertTrue(all(c["tag_style"] == "v2" for c in fake.calls))
        for e in self.m["entries"]:
            self.assertEqual(results[e["id"]]["status"], "ok")
        # The pair members got the same seed.
        seeds = {(c["request"]["prompt"], c["seed"]) for c in fake.calls}
        for p in bp.pairs(self.m):
            self.assertIn((p["A"]["request"]["prompt"], p["seed"]), seeds)
            self.assertIn((p["B"]["request"]["prompt"], p["seed"]), seeds)
        r = results[self.m["entries"][0]["id"]]
        self.assertEqual(r["diagnostics"]["lyric_coverage"], {"value": 0.9, "confidence": "clue"})
        self.assertEqual(r["diagnostics"]["short_by_s"]["value"], 0.2)
        self.assertIn("render_s", r)

    def test_an_interrupted_or_failed_run_resumes_without_rendering_twice(self):
        first = self.m["entries"][5]
        fake = Fake(fail_once={(first["request"]["prompt"], first["request"].get("lyrics"), first["seed"])})
        results = bp.run(self.m, self.out, fake.tools(), log=lambda *_: None)
        self.assertEqual(results[first["id"]]["status"], "failed")
        self.assertIn("no wav file", results[first["id"]]["reason"])
        again = Fake()
        results = bp.run(self.m, self.out, again.tools(), log=lambda *_: None)
        self.assertEqual(len(again.calls), 1)
        self.assertEqual(results[first["id"]]["status"], "ok")
        self.assertEqual(len(bp.read_results(self.out)), 24)

    def test_refuses_to_render_when_the_service_builds_different_tags(self):
        fake = Fake()
        with self.assertRaises(SystemExit) as caught:
            bp.run(self.m, self.out, fake.tools(build_tags=lambda r: "something else"), log=lambda *_: None)
        self.assertIn("disagree", str(caught.exception))
        self.assertEqual(fake.calls, [])

    def test_an_unmeasurable_clue_is_unknown_not_zero(self):
        fake = Fake(coverage=None)
        r = bp.run(self.m, self.out, fake.tools(), only=["en-pop"], log=lambda *_: None)
        self.assertEqual(r["en-pop-s11-A"]["diagnostics"]["lyric_coverage"], {"value": None, "confidence": "unknown"})

    def test_a_section_word_heard_in_the_vocal_is_flagged_unless_the_lyric_sings_it(self):
        fake = Fake(transcript="intro the last train outro")
        r = bp.run(self.m, self.out, fake.tools(), only=["zh-pop"], log=lambda *_: None)
        self.assertEqual(r["zh-pop-s11-B"]["diagnostics"]["section_word_sung"]["value"], ["intro", "outro"])


class Pages(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.out = Path(self.dir.name)
        self.m = bp.load_manifest()
        self.fake = Fake()
        bp.run(self.m, self.out, self.fake.tools(), log=lambda *_: None)

    def tearDown(self):
        self.dir.cleanup()

    def test_the_blind_page_never_says_which_render_is_a(self):
        key = bp.build_pages(self.m, self.out, self.fake.tools(), key_seed=42)
        page = (self.out / "listen" / "index.html").read_text(encoding="utf-8")
        self.assertEqual(sum(p["comparable"] for p in key["pairs"]), 12)
        for e in self.m["entries"]:
            self.assertNotIn(e["id"], page)
            self.assertNotIn(e["request"]["prompt"], page)
        self.assertNotRegex(page, r"\b(arm|A 版|B 版)\b")
        files = sorted(p.name for p in (self.out / "listen").glob("*.mp3"))
        self.assertEqual(len(files), 24)
        self.assertTrue(all(re.fullmatch(r"[0-9a-f]{10}-[XY]\.mp3", f) for f in files))
        # Both sides of a pair played at the target loudness: gain only.
        gains = json.loads((self.out / "gains.json").read_text())
        self.assertTrue(all(g["gain_db"] == bp.TARGET_LUFS - (-14.0) for g in gains.values()))
        # Both arms land on X somewhere: the order is not fixed.
        self.assertEqual({p["X"][-1] for p in key["pairs"]}, {"A", "B"})

    def test_the_key_is_kept_when_pages_are_rebuilt(self):
        first = bp.build_pages(self.m, self.out, self.fake.tools(), key_seed=42)
        second = bp.build_pages(self.m, self.out, self.fake.tools())
        self.assertEqual(first, second)

    def test_a_pair_with_a_failed_render_is_not_put_in_front_of_listeners(self):
        p = bp.pairs(self.m)[0]
        with (self.out / "results.jsonl").open("a") as fh:
            fh.write(json.dumps({"id": p["B"]["id"], "status": "failed", "reason": "boom"}) + "\n")
        key = bp.build_pages(self.m, self.out, self.fake.tools(), key_seed=1)
        entry = next(q for q in key["pairs"] if q["brief"] == p["brief"] and q["seed"] == p["seed"])
        self.assertFalse(entry["comparable"])
        self.assertEqual(entry["missing"], [p["B"]["id"]])


class Score(unittest.TestCase):
    """Spec step 2's rules, on a key and judgments made by hand."""

    def key(self):
        pairs = []
        for brief in ("b1", "b2", "b3"):
            for seed, x in ((11, "A"), (22, "B")):
                pairs.append({"pair": f"{brief}{seed}", "brief": brief, "seed": seed, "comparable": True,
                              "X": f"{brief}-s{seed}-{x}", "Y": f"{brief}-s{seed}-{'B' if x == 'A' else 'A'}"})
        return {"key_seed": 1, "pairs": pairs}

    def judge(self, picks):
        return {"pairs": {t: {"criteria": {"whole": v}} for t, v in picks.items()}}

    def test_per_brief_aggregation_and_listener_agreement(self):
        key = self.key()
        # b1: B wins both seeds. b2: one each way -> tie. b3: listeners disagree on both -> tie.
        one = self.judge({"b111": "Y", "b122": "X", "b211": "Y", "b222": "Y", "b311": "X", "b322": "X"})
        two = self.judge({"b111": "Y", "b122": "X", "b211": "Y", "b222": "Y", "b311": "Y", "b322": "Y"})
        r = bp.score(key, [one, two])["whole"]
        self.assertEqual(r["per_brief"], {"b1": "B", "b2": "tie", "b3": "tie"})
        self.assertEqual((r["B"], r["A"], r["tie"]), (1, 0, 2))
        self.assertAlmostEqual(r["b_win_rate"], 1 / 3, places=3)
        lo, hi = r["ci95"]
        self.assertLessEqual(lo, r["diff"])
        self.assertGreaterEqual(hi, r["diff"])

    def test_a_third_listener_breaks_a_disagreement(self):
        key = self.key()
        picks = lambda v: self.judge({"b111": v, "b122": "same", "b211": "same", "b222": "same", "b311": "same", "b322": "same"})
        r = bp.score(key, [picks("Y"), picks("X"), picks("Y")])["whole"]
        self.assertEqual(r["per_brief"]["b1"], "B")

    def test_a_missing_b_render_is_never_a_b_win(self):
        key = self.key()
        key["pairs"][1] = {"pair": "b122", "brief": "b1", "seed": 22, "comparable": False, "missing": ["b1-s22-B"]}
        r = bp.score(key, [self.judge({"b111": "Y"}), self.judge({"b111": "Y"})])["whole"]
        self.assertEqual(r["per_brief"]["b1"], "tie")


if __name__ == "__main__":
    unittest.main()
