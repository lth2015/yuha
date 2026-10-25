/**
 * The harmonic ground a performance stands on.
 *
 * A preset is what makes "anything you do sounds right" true: the chords move
 * on their own clock and the player only chooses among the notes the current
 * chord allows. Pitches are semitones relative to `root`; the scale is
 * pentatonic, which has no note that clashes hard with another.
 */
export type Preset = {
  id: string;
  bpm: number;
  /** MIDI note the relative pitches are counted from. */
  root: number;
  /** Relative pitch classes a weak-beat note may use. */
  scale: readonly number[];
  /** One chord per `barsPerChord` bars, as relative pitch classes. */
  progression: readonly (readonly number[])[];
  barsPerChord: number;
  /** Lowest and highest MIDI note the lead may play. */
  register: readonly [number, number];
  /** Which voice the synth plays it with (play/synth.ts); the engine never reads it. */
  timbre: 'pluck' | 'qin' | 'glass' | 'mallet';
};

/*
 * Each one must pass every musical property test on its own (tests/air-engine.test.ts
 * runs them per preset), and each one stays only if it is good to listen to: three that
 * make people want to keep playing beat five where two are merely fine.
 */
export const PRESETS: readonly Preset[] = [
  {
    // 晨光: C major pentatonic over I–vi–IV–V. Open, unhurried, familiar.
    id: 'morning',
    bpm: 92,
    root: 60,
    scale: [0, 2, 4, 7, 9],
    progression: [
      [0, 4, 7], // C
      [9, 0, 4], // Am
      [5, 9, 0], // F
      [7, 11, 2], // G
    ],
    barsPerChord: 2,
    register: [55, 84],
    timbre: 'pluck',
  },
  {
    // 江湖: D gong mode, slow, low, plucked like a qin. The "chords" are open fourths and
    // fifths taken from the pentatonic itself, so not one note anywhere is outside the mode.
    id: 'jianghu',
    bpm: 66,
    root: 62,
    scale: [0, 2, 4, 7, 9],
    progression: [
      [0, 7, 2], // D A E
      [9, 2, 4], // B E F♯
      [7, 0, 2], // A D E
      [4, 9, 2], // F♯ B E
    ],
    barsPerChord: 2,
    register: [50, 79],
    timbre: 'qin',
  },
  {
    // 夜: A minor pentatonic over Am–F–C–G, glassy and slow to fade. Late, a little wistful.
    id: 'night',
    bpm: 76,
    root: 57,
    scale: [0, 3, 5, 7, 10],
    progression: [
      [0, 3, 7], // Am
      [8, 0, 3], // F
      [3, 7, 10], // C
      [10, 2, 5], // G
    ],
    barsPerChord: 2,
    register: [55, 84],
    timbre: 'glass',
  },
  {
    // 春: G major pentatonic over IV–V–iii–vi, quicker and wooden. Light on its feet.
    id: 'spring',
    bpm: 104,
    root: 55,
    scale: [0, 2, 4, 7, 9],
    progression: [
      [5, 9, 0], // C
      [7, 11, 2], // D
      [4, 7, 11], // Bm
      [9, 0, 4], // Em
    ],
    barsPerChord: 2,
    register: [55, 84],
    timbre: 'mallet',
  },
];

/** Which preset a performance gets: decided by its seed, so a sketch replays on the same one. */
export const presetFor = (seed: number): Preset => PRESETS[(seed >>> 0) % PRESETS.length]!;
