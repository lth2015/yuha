"""Forced alignment's pure parts: units, the token plan, and the result shape.

No torch, no model: CI runs these with the standard library alone, so the
romanisers are stubbed where a test needs one.
"""
import unittest

from forced import STAR, Unit, build_result, group_spans, line_units, lyric_units, token_plan

DICT = {c: i + 1 for i, c in enumerate("abcdefghijklmnopqrstuvwxyz'")}
DICT["-"] = 0
DICT[STAR] = len(DICT)


def fake_ja(text):
    # What fugashi + cutlet give for the line below, without needing them.
    table = {"小さな": "chiisana", "円": "en", "が": "ga", "「": '"', "1": "1", "は": "wa",
             "JPYC": "JPYC", "」": '"'}
    out, i = [], 0
    while i < len(text):
        for surface in sorted(table, key=len, reverse=True):
            if text.startswith(surface, i):
                out.append((surface, table[surface]))
                i += len(surface)
                break
        else:
            out.append((text[i], ""))
            i += 1
    return out


class UnitTests(unittest.TestCase):
    def test_japanese_words_carry_romaji_and_offsets(self):
        units = line_units(0, "小さな円が", "ja", fake_ja)
        self.assertEqual([(u.first, u.last, u.letters) for u in units],
                         [(0, 3, "chiisana"), (3, 4, "en"), (4, 5, "ga")])

    def test_digits_and_acronyms_are_stars_and_punctuation_is_not_a_unit(self):
        # 「1円は1JPYC」: a digit is a number word in the song's language and an
        # acronym is sung as letter names — neither is the letters on the page.
        units = line_units(0, "「1円は1JPYC」", "ja", fake_ja)
        self.assertEqual([u.letters for u in units], [STAR, "en", "wa", STAR, STAR])
        self.assertEqual([(u.first, u.last) for u in units], [(1, 2), (2, 3), (3, 4), (4, 5), (5, 9)])

    def test_chinese_is_one_unit_per_character(self):
        units = line_units(0, "晚风，吹过", "zh")
        self.assertEqual(len(units), 4)
        self.assertEqual([u.first for u in units], [0, 1, 3, 4])

    def test_english_words(self):
        units = line_units(0, "Stay with me, DJ!", "en")
        self.assertEqual([u.letters for u in units], ["stay", "with", "me", STAR])

    def test_section_tags_are_not_sung(self):
        parsed, units = lyric_units("[Verse]\nStay with me\n[Chorus]\nGo", lang="en")
        self.assertEqual([t for _, t in parsed], ["Stay with me", "Go"])
        self.assertEqual({u.line for u in units}, {0, 1})


class PlanTests(unittest.TestCase):
    def test_a_star_opens_every_line_and_closes_the_song(self):
        units = [Unit(0, 0, 2, "ab"), Unit(0, 3, 4, STAR), Unit(1, 0, 1, "c")]
        tokens, owned = token_plan(units, DICT)
        s = DICT[STAR]
        self.assertEqual(tokens, [s, DICT["a"], DICT["b"], s, s, DICT["c"], s])
        self.assertEqual(owned, [(1, 3), (3, 4), (5, 6)])

    def test_letters_the_model_lacks_become_a_star(self):
        tokens, owned = token_plan([Unit(0, 0, 1, "aé")], DICT)
        self.assertEqual(tokens[owned[0][0]:owned[0][1]], [DICT[STAR]])


class ResultTests(unittest.TestCase):
    def test_lines_take_their_units_times_and_characters_split_a_unit(self):
        parsed = [("Verse", "小さな円"), ("Verse", "が")]
        units = [Unit(0, 0, 3, "chiisana"), Unit(0, 3, 4, "en"), Unit(1, 0, 1, "ga")]
        spans = [(1.0, 2.5, 0.8), (2.5, 3.0, 0.7), (10.0, 10.4, 0.9)]
        out = build_result(parsed, units, spans, 20.0)
        self.assertEqual(out["coverage"], 1.0)
        first, second = out["lines"]
        self.assertEqual((first["start"], first["end"]), (1.0, 3.0))
        self.assertEqual(first["section"], "Verse")
        self.assertEqual([w["start"] for w in first["words"]], [1.0, 1.5, 2.0, 2.5])
        # A long gap is not held over: the next line is 7 s later.
        self.assertEqual(second["start"], 10.0)

    def test_a_breath_between_lines_is_held_through(self):
        parsed = [("", "ab"), ("", "c")]
        units = [Unit(0, 0, 2, "ab"), Unit(1, 0, 1, "c")]
        out = build_result(parsed, units, [(1.0, 2.0, 0.9), (2.8, 3.2, 0.9)], 10.0)
        self.assertEqual(out["lines"][0]["end"], 2.8)

    def test_coverage_counts_lettered_units_found_and_ignores_stars(self):
        parsed = [("", "a 1 b")]
        units = [Unit(0, 0, 1, "a"), Unit(0, 2, 3, STAR), Unit(0, 4, 5, "b")]
        out = build_result(parsed, units, [(1, 2, 0.9), (2, 3, 0.0), (3, 4, 0.01)], 10.0)
        self.assertEqual(out["coverage"], 0.5)

    def test_group_spans_converts_frames_and_averages_scores(self):
        spans = group_spans([(0, 1, 0.2), (10, 12, 0.4), (12, 20, 0.6)], [(1, 3)], 0.02)
        self.assertAlmostEqual(spans[0][0], 0.2)
        self.assertAlmostEqual(spans[0][1], 0.4)
        self.assertAlmostEqual(spans[0][2], 0.5)


if __name__ == "__main__":
    unittest.main()
