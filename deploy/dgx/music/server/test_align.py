"""No model/GPU dependency: exercise the same alignment contract as /v1/align."""
import unittest
from align import align_lines, guess_language, place_units, qwen_lines, voiced_intervals


class SyncedLyricsTests(unittest.TestCase):
    def test_parenthesized_sung_words_are_not_discarded(self):
        lyrics = '[verse]\n晚风吹过\n（别走）\n(ooh ooh)\n[chorus]\n等你回来'
        words = [('晚风吹过', 1, 3), ('别走', 4, 5), ('ooh ooh', 5, 6), ('等你回来', 7, 9)]
        actual = align_lines(lyrics, words, 12)
        self.assertEqual([line['text'] for line in actual['lines']],
                         ['晚风吹过', '（别走）', '(ooh ooh)', '等你回来'])
        self.assertEqual([line['section'] for line in actual['lines']],
                         ['verse', 'verse', 'verse', 'chorus'])

    def test_language_is_detected_from_sung_words_not_section_labels(self):
        self.assertEqual(guess_language('[サビ]\n晚风吹过'), 'zh')
        self.assertEqual(guess_language('[副歌]\nStay with me'), 'en')

    def test_a_stray_single_character_does_not_pull_a_line_early(self):
        # The singer's 我 at 12s was not heard; a 我 misheard inside the
        # previous line's mumble at 6.5s is the only match difflib can give it.
        lyrics = '晚风吹过街角\n在风里\n我等你回来'
        words = [('晚风吹过街角', 1, 4), ('哦', 6, 6.4), ('我', 6.5, 6.8), ('呀', 6.8, 7),
                 ('等你回来', 12.2, 14.5)]
        lines = align_lines(lyrics, words, 20)['lines']
        self.assertGreaterEqual(lines[2]['start'], 12.0)
        # And the character itself is placed inside its own line, not at 6.5s.
        self.assertGreaterEqual(lines[2]['words'][0]['start'], lines[2]['start'])

    def test_a_one_character_line_still_uses_its_only_match(self):
        lyrics = '晚风吹过街角\n啊\n等你回来'
        words = [('晚风吹过街角', 1, 4), ('啊', 6, 7), ('等你回来', 9, 11)]
        lines = align_lines(lyrics, words, 20)['lines']
        self.assertEqual(lines[1]['start'], 6)

    def test_a_start_smeared_into_the_interlude_moves_to_where_the_voice_returns(self):
        # Whisper stretches the first word after an instrumental back into it:
        # 我 "starts" at 8.0 though the vocal stem is silent until 10.2.
        lyrics = '晚风吹过街角\n我等你回来'
        words = [('晚风吹过街角', 1, 4), ('我', 8.0, 10.6), ('等你回来', 10.6, 13)]
        voiced = [(0.9, 4.1), (10.2, 13.1)]
        lines = align_lines(lyrics, words, 20, voiced=voiced)['lines']
        self.assertAlmostEqual(lines[1]['start'], 10.2, places=2)
        self.assertAlmostEqual(lines[0]['start'], 1.0, places=2)
        self.assertGreaterEqual(lines[1]['words'][0]['start'], 10.2)

    def test_an_end_smeared_into_the_interlude_is_pulled_back_to_the_voice(self):
        lyrics = '晚风吹过街角\n我等你回来'
        words = [('晚风吹过', 1, 3), ('街角', 3, 9.5), ('我等你回来', 12, 14)]
        voiced = [(0.9, 4.0), (12.0, 14.0)]
        lines = align_lines(lyrics, words, 20, voiced=voiced)['lines']
        self.assertLess(lines[0]['end'], 5.0)

    def test_without_voice_activity_timings_are_whisper_s(self):
        lyrics = '晚风吹过街角\n我等你回来'
        words = [('晚风吹过街角', 1, 4), ('我', 8.0, 10.6), ('等你回来', 10.6, 13)]
        self.assertEqual(align_lines(lyrics, words, 20)['lines'][1]['start'], 8.0)

    def test_voiced_intervals_from_a_loudness_envelope(self):
        hop = 0.02
        quiet, loud = [-80.0] * 50, [-20.0] * 100   # 1s silence, 2s voice
        env = quiet + loud + [-80.0] * 5 + loud + quiet  # 0.1s gap is one breath
        got = voiced_intervals(env, hop)
        self.assertEqual(len(got), 1)
        self.assertAlmostEqual(got[0][0], 1.0, places=2)
        self.assertAlmostEqual(got[0][1], 5.1, places=2)
        self.assertEqual(voiced_intervals([-90.0] * 100, hop), [])


class LineConfidenceTests(unittest.TestCase):
    """Per-line confidence on the Whisper path, for the shared trusted-line rule (LINE_CONFIDENT 0.5)."""

    def test_a_line_heard_whole_is_confident(self):
        lines = align_lines('晚风吹过街角\n我等你回来', [('晚风吹过街角', 1, 4), ('我等你回来', 6, 9)], 12)['lines']
        self.assertEqual([l['confidence'] for l in lines], [1.0, 1.0])

    def test_a_line_nobody_heard_has_no_confidence(self):
        # The middle line's times are filled in between its neighbours: a guess, not a hearing.
        lines = align_lines('晚风吹过街角\n天上的星星\n我等你回来',
                            [('晚风吹过街角', 1, 4), ('我等你回来', 9, 12)], 15)['lines']
        self.assertEqual(lines[1]['confidence'], 0.0)
        self.assertEqual(lines[0]['confidence'], 1.0)

    def test_a_line_half_heard_is_counted_by_its_characters(self):
        lines = align_lines('晚风吹过街角\n我等你回来了吗', [('晚风吹过街角', 1, 4), ('我等你', 6, 7.5), ('哈哈', 7.5, 9)], 12)['lines']
        self.assertAlmostEqual(lines[1]['confidence'], 3 / 7, places=2)

    def test_a_lone_matched_character_is_weak_evidence(self):
        # One stray 我 in a mumble is a match, but not a hearing of the line.
        lines = align_lines('晚风吹过街角\n我等你', [('晚风吹过街角', 1, 4), ('哦', 6, 6.4), ('我', 6.5, 6.8)], 12)['lines']
        self.assertLess(lines[1]['confidence'], 0.5)

    def test_a_span_dropped_for_breaking_the_order_is_not_trusted(self):
        # 等你回来 "heard" at 2 s, before the first line: dropped and filled in, so not confident.
        lines = align_lines('晚风吹过街角\n等你回来',
                            [('等你回来', 0.5, 2.0), ('晚风吹过街角', 3, 6)], 12)['lines']
        self.assertEqual(lines[1]['confidence'], 0.0)


class PlaceUnitsTests(unittest.TestCase):
    """A forced aligner's timed units placed back on the lyric lines (bench_align.py; a future aligner)."""

    def test_characters_land_on_their_lines(self):
        units = [(c, 1 + i * 0.3, 1.25 + i * 0.3) for i, c in enumerate('晚风吹过')] + \
                [(c, 6 + i * 0.3, 6.25 + i * 0.3) for i, c in enumerate('等你回来')]
        lines = place_units('[verse]\n晚风吹过\n等你回来', units)
        self.assertEqual([l['text'] for l in lines], ['晚风吹过', '等你回来'])
        self.assertAlmostEqual(lines[0]['start'], 1.0)
        self.assertAlmostEqual(lines[1]['start'], 6.0)
        self.assertAlmostEqual(lines[1]['end'], 7.15)
        self.assertEqual([l['confidence'] for l in lines], [1.0, 1.0])

    def test_english_words_and_punctuation(self):
        lines = place_units('Stay with me,\nnight', [('Stay', 1, 1.4), ('with', 1.4, 1.7), ('me', 1.7, 2.2), ('night', 4, 5)])
        self.assertEqual([l['start'] for l in lines], [1, 4])
        self.assertEqual(lines[0]['confidence'], 1.0)

    def test_a_line_the_aligner_left_out_has_no_time(self):
        lines = place_units('晚风吹过\n天上\n等你', [('晚', 1, 1.2), ('风', 1.2, 1.4), ('吹', 1.4, 1.6), ('过', 1.6, 1.8), ('等', 5, 5.2), ('你', 5.2, 5.4)])
        self.assertIsNone(lines[1]['start'])
        self.assertEqual(lines[1]['confidence'], 0.0)


def chars(text, start, step=0.25):
    return [(c, start + i * step, start + (i + 1) * step) for i, c in enumerate(text)]


class QwenLinesTests(unittest.TestCase):
    """A forced aligner's lines, with confidence from where the voice is and what Whisper heard."""
    LYRICS = '晚风吹过街角\n我等你回来\n天上的星星'

    def test_lines_placed_where_someone_is_singing_are_confident(self):
        units = chars('晚风吹过街角', 2) + chars('我等你回来', 6) + chars('天上的星星', 10)
        lines = qwen_lines(self.LYRICS, units, 15, voiced=[(1.9, 3.6), (5.9, 7.4), (9.9, 11.4)])
        self.assertEqual([l['confidence'] for l in lines], [1.0, 1.0, 1.0])
        self.assertEqual([l['start'] for l in lines], [2, 6, 10])

    def test_a_line_placed_in_an_instrumental_is_not_trusted(self):
        units = chars('晚风吹过街角', 2) + chars('我等你回来', 6) + chars('天上的星星', 10)
        lines = qwen_lines(self.LYRICS, units, 15, voiced=[(1.9, 3.6), (9.9, 11.4)])  # nobody sings at 6 s
        self.assertLess(lines[1]['confidence'], 0.5)
        self.assertEqual(lines[0]['confidence'], 1.0)

    def test_a_line_whisper_heard_somewhere_else_is_not_trusted(self):
        units = chars('晚风吹过街角', 2) + chars('我等你回来', 6) + chars('天上的星星', 10)
        heard = [{'start': 2.0, 'confidence': 1.0}, {'start': 8.5, 'confidence': 1.0}, {'start': 9.8, 'confidence': 0.0}]
        lines = qwen_lines(self.LYRICS, units, 15, heard=heard)
        self.assertLess(lines[1]['confidence'], 0.5)   # 2.5 s from where Whisper heard it
        self.assertEqual(lines[0]['confidence'], 1.0)  # agrees
        self.assertEqual(lines[2]['confidence'], 1.0)  # Whisper did not hear it: no say

    def test_a_line_the_aligner_left_out_is_filled_in_and_unsure(self):
        units = chars('晚风吹过街角', 2) + chars('天上的星星', 10)
        lines = qwen_lines(self.LYRICS, units, 15)
        self.assertEqual(lines[1]['confidence'], 0.0)
        self.assertGreaterEqual(lines[1]['start'], lines[0]['start'])
        self.assertLessEqual(lines[1]['end'], lines[2]['start'])
        for l in lines:
            self.assertIsInstance(l['start'], float)
            self.assertIsInstance(l['end'], float)


if __name__ == '__main__':
    unittest.main()
