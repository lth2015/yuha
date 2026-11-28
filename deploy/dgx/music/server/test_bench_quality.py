"""bench_quality: sections from an alignment, and the A/B summary and page (no audio libraries needed)."""
import unittest

import bench_production as bp
import bench_quality as bq


def measured(motif: float, lift: float, close: float, coverage: float = 0.9) -> dict:
    return {
        "lyric_coverage": coverage,
        "structure": {"motif_margin": motif, "chorus_recurrence": 0.8},
        "lift": {"chorus_lift_db": lift},
        "vocal": {"vocal_ratio_db": 3.0},
        "time_key": {"tempo_drift": 0.01, "key_agreement": 0.9},
        "ending": {"close_minus_body_db": close},
        "loudness": {"lufs": -14.0, "lra": 6.0, "true_peak_db": -1.2},
    }


class Sections(unittest.TestCase):
    def test_consecutive_lines_of_a_section_become_one_span_with_intro_and_outro_around(self):
        al = {"lines": [
            {"section": "verse", "start": 8.0, "end": 10.0}, {"section": "verse", "start": 10.5, "end": 14.0},
            {"section": "chorus", "start": 15.0, "end": 20.0}, {"section": "Pre-Chorus", "start": 20.5, "end": 22.0},
            {"section": "chorus", "start": 22.5, "end": 30.0}, {"section": "", "start": 31.0, "end": 33.0},
        ]}
        spans = bq.sections_from(al, 40.0)
        self.assertEqual([(s["name"], s["start"], s["end"]) for s in spans], [
            ("intro", 0.0, 8.0), ("verse", 8.0, 14.0), ("chorus", 15.0, 20.0), ("pre-chorus", 20.5, 22.0),
            ("chorus", 22.5, 30.0), ("verse", 31.0, 33.0), ("outro", 33.0, 40.0)])

    def test_no_aligned_lines_means_no_sections_rather_than_invented_ones(self):
        self.assertEqual(bq.sections_from({"lines": []}, 40.0), [])


class Summary(unittest.TestCase):
    def setUp(self):
        self.m = bp.load_manifest()

    def all_pairs(self, a, b):
        return {e["id"]: (a if e["arm"] == "A" else b) for e in self.m["entries"]}

    def test_b_minus_a_per_pair_and_direction_aware_counts(self):
        # B: hook returns more, ending quieter (better), same lift.
        s = bq.summarise(self.m, self.all_pairs(measured(0.1, 3.0, -2.0), measured(0.4, 3.0, -8.0)))
        self.assertEqual(len(s["pairs"]), 12)
        o = s["overall"]
        self.assertAlmostEqual(o["motif_margin"]["mean_delta"], 0.3, places=3)
        self.assertEqual(o["motif_margin"]["sign_test"]["b_higher"], 12)
        # Lower is better for the ending: a quieter close counts for B.
        self.assertEqual(o["close_minus_body_db"]["sign_test"]["b_higher"], 12)
        self.assertEqual(o["chorus_lift_db"]["sign_test"], None)  # a band, not a direction
        self.assertEqual((o["close_minus_body_db"]["in_band_A"], o["close_minus_body_db"]["in_band_B"]), (0, 12))

    def test_a_failed_measurement_drops_its_pair_rather_than_counting_as_zero(self):
        renders = self.all_pairs(measured(0.1, 3.0, -2.0), measured(0.4, 3.0, -8.0))
        renders[self.m["entries"][0]["id"]] = {"error": "RuntimeError: demucs"}
        s = bq.summarise(self.m, renders)
        self.assertEqual(len(s["pairs"]), 11)

    def test_the_page_names_every_measure_and_says_what_it_cannot_tell(self):
        s = bq.summarise(self.m, self.all_pairs(measured(0.1, 3.0, -2.0), measured(0.4, 3.0, -8.0)))
        page = bq.page(s, 24)
        for label in bq.LABELS.values():
            self.assertIn(label, page)
        self.assertIn("测不到的", page)
        self.assertIn("p 是符号检验", page)

    def test_the_page_says_which_measures_passed_their_planted_check(self):
        s = bq.summarise(self.m, self.all_pairs(measured(0.1, 3.0, -2.0), measured(0.4, 3.0, -8.0)))
        page = bq.page(s, 24, {"lra": True, "tempo_drift": False})
        row = lambda label: page[page.index(label):page.index("</tr>", page.index(label))]  # noqa: E731
        self.assertIn("✓ 已验证", row(bq.LABELS["lra"]))
        self.assertIn("✗ 未通过，不作判断", row(bq.LABELS["tempo_drift"]))
        self.assertIn("未验证", row(bq.LABELS["vocal_ratio_db"]))


if __name__ == "__main__":
    unittest.main()
