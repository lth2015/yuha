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


class Resume(unittest.TestCase):
    """Review of #191: a resumed run must not reuse renders made under another configuration."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.out = Path(self.dir.name)
        self.m = bp.load_manifest()

    def tearDown(self):
        self.dir.cleanup()

    def tools(self, **env):
        t = Fake().tools()
        t.environment = {"engine": "v15", "v15_model": "v1", **env}
        return t

    def test_a_different_model_in_the_same_directory_is_refused_not_mixed(self):
        bp.run(self.m, self.out, self.tools(), only=["zh-pop"], log=lambda *_: None)
        fake = Fake()
        other = fake.tools()
        other.environment = {"engine": "v15", "v15_model": "v2"}
        with self.assertRaises(SystemExit) as caught:
            bp.run(self.m, self.out, other, only=["zh-pop", "ja-pop"], log=lambda *_: None)
        self.assertIn("different request or configuration", str(caught.exception))
        self.assertEqual(fake.calls, [])
        # Nothing written: the old experiment's environment is still the one on disk.
        self.assertEqual(json.loads((self.out / "environment.json").read_text())["v15_model"], "v1")

    def test_the_same_configuration_resumes_and_only_renders_what_is_new(self):
        bp.run(self.m, self.out, self.tools(), only=["zh-pop"], log=lambda *_: None)
        fake = Fake()
        same = fake.tools()
        same.environment = {"engine": "v15", "v15_model": "v1", "build_sha": "a later build"}
        bp.run(self.m, self.out, same, only=["zh-pop", "ja-pop"], log=lambda *_: None)
        self.assertEqual(len(fake.calls), 4)
        self.assertTrue(all("ja" in c["request"]["prompt"] or "j-pop" in c["request"]["prompt"] for c in fake.calls))

    def test_records_written_before_the_fingerprint_existed_still_resume(self):
        # The run on the DGX on 2026-11-28 wrote records without a fingerprint field.
        bp.run(self.m, self.out, self.tools(), only=["zh-pop"], log=lambda *_: None)
        self.assertNotIn("fingerprint", next(iter(bp.read_results(self.out).values())))
        fake = Fake()
        again = fake.tools()
        again.environment = {"engine": "v15", "v15_model": "v1"}
        bp.run(self.m, self.out, again, only=["zh-pop"], log=lambda *_: None)
        self.assertEqual(fake.calls, [])


class Score(unittest.TestCase):
    """Spec step 2's rules, tightened by the review of #191, on keys and judgments made by hand."""

    def key(self, briefs=("zh-b1", "zh-b2", "zh-b3")):
        pairs = []
        for brief in briefs:
            for seed, x in ((11, "A"), (22, "B")):
                pairs.append({"pair": f"{brief}{seed}", "brief": brief, "seed": seed, "comparable": True,
                              "X": f"{brief}-s{seed}-{x}", "Y": f"{brief}-s{seed}-{'B' if x == 'A' else 'A'}"})
        return {"key_seed": 1, "pairs": pairs}

    def judge(self, who, picks, languages="中文"):
        return {"reviewer": who, "languages": languages, "pairs": {t: {"criteria": {"whole": v}} for t, v in picks.items()}}

    def whole(self, key, judgments):
        return bp.score(key, judgments)["whole"]

    def test_two_agreeing_reviewers_decide_and_seeds_aggregate_per_brief(self):
        key = self.key()
        # zh-b1: B both seeds. zh-b2: one each way -> tie. zh-b3: the two agree on A at s11, tie at s22.
        picks = {"zh-b111": "Y", "zh-b122": "X", "zh-b211": "Y", "zh-b222": "Y", "zh-b311": "X", "zh-b322": "same"}
        r = self.whole(key, [self.judge("a", picks), self.judge("b", picks)])
        self.assertEqual(r["formal"]["per_brief"], {"zh-b1": "B", "zh-b2": "tie", "zh-b3": "A"})
        self.assertTrue(r["formal"]["complete"])
        self.assertEqual((r["formal"]["B"], r["formal"]["A"], r["formal"]["tie"]), (1, 1, 1))
        lo, hi = r["formal"]["ci95"]
        self.assertLessEqual(lo, r["formal"]["diff"])
        self.assertGreaterEqual(hi, r["formal"]["diff"])

    def test_one_reviewer_is_a_preview_never_a_result(self):
        key = self.key(("zh-b1",))
        r = self.whole(key, [self.judge("a", {"zh-b111": "Y", "zh-b122": "X"})])
        self.assertEqual(r["formal"]["per_brief"], {"zh-b1": "pending"})
        self.assertEqual(r["formal"]["B"], 0)
        self.assertFalse(r["formal"]["complete"])
        self.assertEqual(r["preview"]["per_brief"], {"zh-b1": "B"})
        self.assertIn("two independent reviews", " ".join(r["why_pending"]["zh-b1"]))

    def test_a_disagreement_waits_for_a_third_reviewer(self):
        key = self.key(("zh-b1",))
        p = lambda v: {"zh-b111": v, "zh-b122": "same"}  # noqa: E731
        two = self.whole(key, [self.judge("a", p("Y")), self.judge("b", p("X"))])
        self.assertEqual(two["formal"]["per_brief"]["zh-b1"], "pending")
        three = self.whole(key, [self.judge("a", p("Y")), self.judge("b", p("X")), self.judge("c", p("Y"))])
        self.assertEqual(three["formal"]["per_brief"]["zh-b1"], "B")

    def test_reviewers_who_do_not_know_the_language_cannot_decide_it(self):
        key = self.key(("ja-b1",))
        picks = {"ja-b111": "Y", "ja-b122": "X"}
        r = self.whole(key, [self.judge("a", picks, "中文"), self.judge("b", picks, "English")])
        self.assertEqual(r["formal"]["per_brief"]["ja-b1"], "pending")
        r = self.whole(key, [self.judge("a", picks, "中文"), self.judge("b", picks, "日本語")])
        self.assertEqual(r["formal"]["per_brief"]["ja-b1"], "B")

    def test_codex_reproduction_one_seed_missing_both_renders_is_not_a_b_win(self):
        # Review of #191: s11 complete with a single B vote; s22 rendered neither arm. Was: B, 100%.
        key = self.key(("zh-b1",))
        key["pairs"][1] = {"pair": "zh-b122", "brief": "zh-b1", "seed": 22, "comparable": False,
                           "missing": ["zh-b1-s22-A", "zh-b1-s22-B"]}
        one = self.whole(key, [self.judge("a", {"zh-b111": "Y"})])
        self.assertNotEqual(one["formal"]["per_brief"]["zh-b1"], "B")
        self.assertEqual(one["formal"]["b_win_rate"], 0)
        # ...and with two reviewers agreeing on B at s11, still not a B win.
        two = self.whole(key, [self.judge("a", {"zh-b111": "Y"}), self.judge("b", {"zh-b111": "Y"})])
        self.assertNotEqual(two["formal"]["per_brief"]["zh-b1"], "B")
        self.assertNotEqual(two["preview"]["per_brief"]["zh-b1"], "B")
        self.assertEqual(two["pairs"]["missing_render"], 1)

    def test_a_missing_b_render_is_never_a_b_win(self):
        key = self.key(("zh-b1",))
        key["pairs"][1] = {"pair": "zh-b122", "brief": "zh-b1", "seed": 22, "comparable": False, "missing": ["zh-b1-s22-B"]}
        picks = {"zh-b111": "Y"}
        r = self.whole(key, [self.judge("a", picks), self.judge("b", picks)])
        self.assertEqual(r["formal"]["per_brief"]["zh-b1"], "tie")

    def test_a_reexport_replaces_a_reviewers_votes_rather_than_counting_twice(self):
        key = self.key(("zh-b1",))
        r = self.whole(key, [self.judge("a", {"zh-b111": "Y", "zh-b122": "X"}),
                             self.judge("a", {"zh-b111": "Y", "zh-b122": "X"})])
        self.assertEqual(r["formal"]["per_brief"]["zh-b1"], "pending")

    def test_counts_are_reported_apart(self):
        key = self.key(("zh-b1", "zh-b2"))
        key["pairs"][3] = {"pair": "zh-b222", "brief": "zh-b2", "seed": 22, "comparable": False, "missing": ["zh-b2-s22-A"]}
        r = self.whole(key, [self.judge("a", {"zh-b111": "Y", "zh-b122": "X"}), self.judge("b", {"zh-b111": "Y"})])
        self.assertEqual(r["pairs"], {"missing_render": 1, "missing_review": 1, "pending": 1, "tie": 0, "decided": 1})


if __name__ == "__main__":
    unittest.main()
