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
};

export const PRESETS: readonly Preset[] = [
  {
    // C major pentatonic over I–vi–IV–V: open, unhurried, familiar.
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
  },
];
