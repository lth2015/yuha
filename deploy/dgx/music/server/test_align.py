"""No model/GPU dependency: exercise the same alignment contract as /v1/align."""
import unittest
from align import align_lines, guess_language, voiced_intervals


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


if __name__ == '__main__':
    unittest.main()
