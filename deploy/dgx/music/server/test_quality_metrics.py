"""quality_metrics: each measure separates a constructed good case from a constructed bad one."""
import unittest

import numpy as np

import quality_metrics as qm

NOTES = {n: i for i, n in enumerate(qm.KEY_NAMES)}


def melody(notes, frames_each=8, noise=0.05, seed=0):
    """A chroma sequence for a line of notes: one pitch class lit per note, some spill."""
    rng = np.random.default_rng(seed)
    cols = []
    for n in notes:
        v = np.full(12, noise)
        v[NOTES[n]] = 1.0
        v[(NOTES[n] + 7) % 12] += 0.3  # the fifth rings too
        for _ in range(frames_each):
            cols.append(v + rng.uniform(0, noise, 12))
    return np.array(cols).T


HOOK = ["C", "E", "G", "A"]
VERSE = ["D", "F", "D", "B", "D", "F"]


class Similarity(unittest.TestCase):
    def test_a_line_is_closer_to_itself_sung_slower_than_to_another_line(self):
        a = melody(HOOK)
        slower = melody(HOOK, frames_each=12, seed=1)
        other = melody(VERSE, seed=2)
        same, diff = qm.dtw_similarity(a, slower), qm.dtw_similarity(a, other)
        self.assertGreater(same, 0.9)
        self.assertGreater(same - diff, 0.2)

    def test_the_intros_figure_is_found_inside_a_longer_chorus_and_not_inside_a_verse_without_it(self):
        figure = melody(HOOK, seed=3)
        chorus = melody(["F", "D"] + HOOK + ["G", "F"], seed=4)
        verse = melody(VERSE + VERSE, seed=5)
        self.assertGreater(qm.best_match(figure, chorus) - qm.best_match(figure, verse), 0.2)

    def test_empty_input_is_not_a_number(self):
        self.assertIsNone(qm.dtw_similarity(np.zeros((12, 0)), melody(HOOK)))
        self.assertIsNone(qm.best_match(melody(HOOK), np.zeros((12, 0))))

    def test_downsample_keeps_the_shape_of_the_line(self):
        a = melody(HOOK, frames_each=16)
        self.assertEqual(qm.downsample(a, 4).shape, (12, 16))
        self.assertGreater(qm.dtw_similarity(qm.downsample(a, 4), melody(HOOK, frames_each=4)), 0.9)


class Key(unittest.TestCase):
    def test_a_c_major_scale_weight_reads_as_c_major_and_a_minor_as_a_minor(self):
        c_major = np.zeros(12)
        for n, w in zip(["C", "D", "E", "F", "G", "A", "B"], [6, 2, 4, 3, 5, 3, 2]):
            c_major[NOTES[n]] = w
        self.assertEqual(qm.key_of(c_major)[0], "C major")
        a_minor = np.zeros(12)
        for n, w in zip(["A", "B", "C", "D", "E", "F", "G"], [6, 2, 4, 4, 5, 3, 3]):
            a_minor[NOTES[n]] = w
        self.assertEqual(qm.key_of(a_minor)[0], "A minor")

    def test_a_verse_on_the_relative_minor_is_not_a_change_of_key(self):
        c = melody(["C", "E", "G", "C", "F", "A"] * 4, seed=9)
        a_minor = melody(["A", "C", "E", "A", "D", "F"] * 4, seed=10)
        self.assertGreater(qm.key_consistency(np.concatenate([c, a_minor, c], axis=1), 48)[1], 0.9)

    def test_a_song_that_changes_key_halfway_agrees_with_itself_about_half_the_time(self):
        c = melody(["C", "E", "G", "C", "F", "A"] * 4, seed=6)
        fsharp = melody(["F#", "A#" if False else "Bb", "C#", "F#", "B", "Eb"] * 4, seed=7)
        steady = qm.key_consistency(np.concatenate([c, c], axis=1), 48)[1]
        split = qm.key_consistency(np.concatenate([c, fsharp], axis=1), 48)[1]
        self.assertGreater(steady, 0.9)
        self.assertLess(split, 0.75)


class TimeAndEnding(unittest.TestCase):
    def test_a_steady_beat_varies_less_than_a_dragging_one(self):
        steady = np.arange(40) * 0.5
        drag = np.cumsum(0.5 + np.random.default_rng(8).normal(0, 0.06, 40))
        self.assertLess(qm.interval_cv(steady), 0.01)
        self.assertGreater(qm.interval_cv(drag), 0.05)

    def test_each_half_is_timed_on_its_own_so_a_slowdown_halfway_reads_as_drift(self):
        hop_s = 512 / 22050

        def clicks(bpm: float, seconds: float, jitter: float = 0.0) -> np.ndarray:
            env = np.zeros(int(seconds / hop_s))
            rng = np.random.default_rng(3)
            t = 0.0
            while t < seconds - 0.1:
                env[int((t + rng.normal(0, jitter)) / hop_s) % env.size] += 1.0
                t += 60.0 / bpm
            return np.convolve(env, [0.3, 1.0, 0.5, 0.2], mode="same") + rng.random(env.size) * 0.05

        song = np.concatenate([clicks(120, 60), clicks(102, 60)])
        whole = qm.periodicity_bpm(song, hop_s)
        first = qm.periodicity_bpm(song[: song.size // 2], hop_s, near=whole)
        slower = qm.periodicity_bpm(song[song.size // 2:], hop_s, near=whole)
        self.assertAlmostEqual(first, 120, delta=1.5)
        self.assertAlmostEqual(slower, 102, delta=1.5)
        self.assertAlmostEqual(qm.tempo_drift(first, slower), 1 - 102 / 120, delta=0.01)
        # A steady song with a little human timing reads well under the 3% reference.
        steady = clicks(117, 120, jitter=0.01)
        w = qm.periodicity_bpm(steady, hop_s)
        a, b = qm.periodicity_bpm(steady[: steady.size // 2], hop_s, near=w), qm.periodicity_bpm(steady[steady.size // 2:], hop_s, near=w)
        self.assertAlmostEqual(w, 117, delta=1.5)
        self.assertLess(qm.tempo_drift(a, b), 0.01)

    def test_a_half_read_at_double_time_is_not_drift(self):
        self.assertAlmostEqual(qm.tempo_drift(120, 240), 0.0)
        self.assertAlmostEqual(qm.tempo_drift(120, 61), 122 / 120 - 1, places=6)
        self.assertIsNone(qm.tempo_drift(None, 120))

    def test_a_song_that_winds_down_reads_lower_at_the_close_than_one_that_stops(self):
        hop = 0.05
        body = np.full(2000, -14.0)
        winds_down = np.concatenate([body, np.linspace(-14, -30, 80), np.linspace(-30, -60, 20)])
        stops = np.concatenate([body, np.full(80, -14.0), np.linspace(-14, -60, 20)])  # only the master fade
        self.assertLess(qm.ending(winds_down, hop)["close_minus_body_db"], -6)
        self.assertGreater(qm.ending(stops, hop)["close_minus_body_db"], -1)


class Paired(unittest.TestCase):
    def test_sign_test(self):
        self.assertEqual(qm.sign_test([1, 1, 1, 1, 1, 1]), {"b_higher": 6, "b_lower": 0, "n": 6, "p": 0.031})
        self.assertEqual(qm.sign_test([1, -1, 1, -1, None, 0])["p"], 1.0)
        self.assertIsNone(qm.sign_test([None, None])["p"])


if __name__ == "__main__":
    unittest.main()
