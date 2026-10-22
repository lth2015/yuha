"""No model/GPU dependency: exercise the same alignment contract as /v1/align."""
import unittest
from align import align_lines, guess_language


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


if __name__ == '__main__':
    unittest.main()
