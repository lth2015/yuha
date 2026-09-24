import type { Mood, Scene, TempoHint } from '@yuha/contracts';
import type { IntentRequest, IntentResult, ReviseRequest, ReviseResult, TextProvider } from './types.js';

/**
 * Deterministic local intent extractor for demo mode and tests.
 *
 * It is a keyword mapper, not a language model: it exists so the whole
 * generation pipeline can run without external credentials. Its provider id
 * is recorded on every job, so nothing produced through it can be mistaken for
 * evidence that a real text model was called (§12.2).
 */
export class LocalTextProvider implements TextProvider {
  readonly providerId = 'local-rules';
  readonly model = 'keyword-map-v2';

  private static readonly MOOD_HINTS: Array<[RegExp, Mood]> = [
    [/(calm|chill|lo-?fi|quiet|peaceful|静か|落ち着)/i, 'calm'],
    [/(dreamy|ethereal|ambient|float|夢|ふわ)/i, 'dreamy'],
    [/(warm|cozy|acoustic|nostalg|あたたか|ほっこり)/i, 'warm'],
    [/(sad|melanchol|lonely|bitter|切な|寂し)/i, 'melancholic'],
    [/(confident|cool|trap|hip.?hop|swagger|かっこ)/i, 'confident'],
    [/(playful|fun|pop|quirky|cute|楽し|かわい)/i, 'playful'],
    [/(tense|dark|intense|horror|cinematic|緊張|シリアス)/i, 'tense'],
    [/(uplift|bright|epic|anthem|festival|元気|前向)/i, 'uplifting'],
  ];

  /** Style tag → internal scene, so demo fixture picking keeps working. */
  private static readonly STYLE_SCENES: Array<[RegExp, Scene]> = [
    [/(lo-?fi|chill|ambient|study|night|midnight|jazz)/i, 'night_walk'],
    [/(vlog|daily|acoustic|folk|morning|coffee)/i, 'daily_log'],
    [/(trap|hip.?hop|rap|drill|edm|house|techno|club|fashion)/i, 'outfit'],
    [/(synthwave|arcade|8.?bit|game|epic|battle|rock|metal)/i, 'gaming'],
  ];

  private static readonly SCENE_DEFAULTS: Record<string, { mood: Mood; tempo: TempoHint; instruments: string[] }> = {
    night_walk: { mood: 'calm', tempo: 'slow', instruments: ['synth_pad', 'soft_drums', 'sub_bass'] },
    daily_log: { mood: 'warm', tempo: 'medium', instruments: ['electric_piano', 'brushed_drums', 'bass'] },
    outfit: { mood: 'confident', tempo: 'medium', instruments: ['synth_bass', 'claps', 'pluck'] },
    gaming: { mood: 'tense', tempo: 'fast', instruments: ['arp_synth', 'drum_machine', 'saw_bass'] },
  };

  /** Title words per mood — the local "auto-titler" for untitled songs. */
  private static readonly TITLE_WORDS: Record<Mood, readonly [string, string]> = {
    calm: ['Still Water', 'Quiet Light'],
    dreamy: ['Paper Moon', 'Slow Orbit'],
    warm: ['Golden Hour', 'Kitchen Light'],
    melancholic: ['Empty Platform', 'Last Train'],
    confident: ['Chrome Heart', 'Front Row'],
    playful: ['Sugar Static', 'Balloon Ride'],
    tense: ['Night Signal', 'Cold Wire'],
    uplifting: ['Open Sky', 'First Light'],
  };

  private static readonly TITLE_SUFFIX = ['Loop', 'Drift', 'Sketch', 'Scene', 'Static', 'Bloom'];

  /** Deterministic small int from a string, for stable title choice. */
  private static hashInt(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }

  private sceneFor(req: IntentRequest): Scene {
    const hay = `${req.styles.join(' ')} ${req.prompt}`;
    for (const [pattern, scene] of LocalTextProvider.STYLE_SCENES) {
      if (pattern.test(hay)) return scene;
    }
    return 'daily_log';
  }

  async extractIntent(req: IntentRequest): Promise<IntentResult> {
    const scene = this.sceneFor(req);
    const defaults = LocalTextProvider.SCENE_DEFAULTS[scene] ?? LocalTextProvider.SCENE_DEFAULTS['daily_log']!;

    let mood = defaults.mood;
    for (const [pattern, m] of LocalTextProvider.MOOD_HINTS) {
      if (pattern.test(req.prompt) || req.styles.some((s) => pattern.test(s))) {
        mood = m;
        break;
      }
    }

    const tempo: TempoHint = req.energy >= 0.7 ? 'fast' : req.energy <= 0.33 ? 'slow' : defaults.tempo;

    // Fault-injection markers ride along in the brief so the demo music
    // provider can act on them. This exists only in the demo adapter pair, and
    // lets the GEN-* failure tests exercise the real worker path rather than a
    // test-only branch inside it.
    const marker = /__FAULT_[A-Z]+__/.exec(req.prompt)?.[0] ?? '';

    const styles =
      req.styles.length > 0
        ? req.styles.slice(0, 6)
        : [mood, tempo === 'fast' ? 'upbeat' : tempo === 'slow' ? 'slow' : 'mid-tempo', 'instrumental'];

    const vocalMode = req.instrumental ? ('instrumental' as const) : ('with_vocals' as const);
    const hasLyrics = vocalMode === 'with_vocals' && !!req.lyrics;

    const brief =
      `${styles.slice(0, 3).join(', ')} ${tempo}-tempo song, ${mood} mood, ` +
      `${req.instrumental ? 'no vocals' : hasLyrics ? 'with sung lyrics' : 'melodic lead vocal'}, ` +
      `${defaults.instruments.join(', ')}, ${req.durationSeconds}s${marker ? ` ${marker}` : ''}`;

    const title = req.title ?? this.autoTitle(req, mood);

    return {
      status: 'ok',
      requestId: null,
      repaired: false,
      usage: { costMinor: 0, costIsEstimate: true },
      intent: {
        scene,
        mood,
        energy: req.energy,
        tempoHint: tempo,
        instruments: defaults.instruments,
        durationSeconds: req.durationSeconds,
        vocalMode,
        styles,
        // The brief is capped at the contract maximum.
        brief: brief.slice(0, 400),
        lyrics: hasLyrics ? req.lyrics!.slice(0, 3000) : null,
        title: title.slice(0, 120),
      },
    };
  }

  /**
   * Deterministic revision for demo mode: passes the song through unchanged
   * apart from echoing instructions into the brief the worker will see. A real
   * rewrite needs the model — with the local provider this exists so the edit
   * flow, credits and pipeline are exercisable without credentials.
   */
  async reviseSong(req: ReviseRequest): Promise<ReviseResult> {
    return {
      status: 'ok',
      title: req.original.title,
      styles: req.original.styles,
      lyrics: req.original.lyrics,
      usage: { costMinor: 0, costIsEstimate: true },
    };
  }

  /** Untitled songs still deserve a name on the card; deterministic per request. */
  private autoTitle(req: IntentRequest, mood: Mood): string {
    const h = LocalTextProvider.hashInt(`${req.prompt}|${req.styles.join(',')}|${req.durationSeconds}`);
    const pair: readonly [string, string] = LocalTextProvider.TITLE_WORDS[mood] ?? ['Untitled', 'Sketch'];
    const word = h % 2 === 0 ? pair[0] : pair[1];
    if (h % 3 === 0) return `${word} ${LocalTextProvider.TITLE_SUFFIX[h % LocalTextProvider.TITLE_SUFFIX.length]!}`;
    return word;
  }
}
