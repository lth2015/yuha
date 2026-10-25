/**
 * Turns note events into sound. Takes any BaseAudioContext, so the same voices
 * play live and render offline (the listening recordings for #28 are made
 * that way, so what is approved is what plays).
 *
 * Three voices: a soft plucked lead whose brightness follows height, harmony
 * in the same voice a little softer, and a slow pad under them. Each note is
 * placed in the stereo field by its pan; width (openness) sends more of it to
 * the generated reverb and adds overtones. A gentle compressor keeps many
 * notes at once a texture instead of getting loud.
 */
import type { NoteEvent } from '../engine/performer.ts';
import type { Preset } from '../engine/presets.ts';

/**
 * A preset's voice. `pluck` is exactly the sound approved in #28/#29; the others were
 * added for #33 and are judged the same way, by ear.
 *
 * partials: [wave, ratio to the note, level, extra level at full openness]
 */
type Timbre = {
  partials: readonly (readonly [OscillatorType, number, number, number])[];
  attack: number;
  /** Seconds from the peak down to `sustain`, a fraction of the peak. */
  decay: number;
  sustain: number;
  /** Time constant of the fade after the note's length. */
  release: number;
  /** Cents the note starts below its pitch, sliding up into it (a qin's 吟猱). 0: none. */
  glide: number;
  /** Lowpass cutoff: base + brightness × span. */
  cutoff: readonly [number, number];
  /** Reverb send at rest; openness adds `sendOpen`. */
  send: number;
  sendOpen: number;
  pad: { wave: OscillatorType; level: number; detune: number };
  /** Room length in seconds, and how much of it is heard. */
  room: number;
  wet: number;
  /** Evens out loudness between timbres (set by measuring renders). */
  gain: number;
};

const TIMBRES: Record<Preset['timbre'], Timbre> = {
  pluck: {
    partials: [
      ['triangle', 1, 1, 0],
      ['sine', 2, 0.18, 0.22],
      ['sine', 3, 0, 0.1],
    ],
    attack: 0.008,
    decay: 0.342, // peak to sustain by 0.35 s, as approved
    sustain: 0.35,
    release: 0.25,
    glide: 0,
    cutoff: [700, 4300],
    send: 0.25,
    sendOpen: 0.6,
    pad: { wave: 'sawtooth', level: 0.045, detune: 6 },
    room: 2.2,
    wet: 0.32,
    gain: 1,
  },
  // A plucked silk string: quick bright attack, a long woody decay, a small slide up
  // into each note, and a long hall. The pad is a near-silent drone, not a chord bed.
  qin: {
    partials: [
      ['triangle', 1, 1, 0],
      ['sine', 2, 0.32, 0.12],
      ['sine', 3, 0.12, 0.08],
      ['sine', 4.01, 0.05, 0.04],
    ],
    attack: 0.004,
    decay: 0.9,
    sustain: 0.12,
    release: 0.6,
    glide: -45,
    cutoff: [900, 2600],
    send: 0.35,
    sendOpen: 0.5,
    pad: { wave: 'sine', level: 0.03, detune: 0 },
    room: 3.2,
    wet: 0.38,
    gain: 1,
  },
  // Struck glass: a pure tone with a bell's inharmonic overtone, ringing long.
  glass: {
    partials: [
      ['sine', 1, 1, 0],
      ['sine', 2.76, 0.22, 0.12],
      ['sine', 5.4, 0.06, 0.05],
    ],
    attack: 0.01,
    decay: 1.2,
    sustain: 0.2,
    release: 0.8,
    glide: 0,
    cutoff: [2000, 5000],
    send: 0.4,
    sendOpen: 0.45,
    pad: { wave: 'triangle', level: 0.04, detune: 4 },
    room: 3,
    wet: 0.4,
    gain: 0.71, // rendered 3 dB louder than pluck on average
  },
  // A soft wooden mallet: almost all attack, a fourth-harmonic knock, a short room.
  mallet: {
    partials: [
      ['sine', 1, 1, 0],
      ['sine', 4, 0.28, 0.1],
      ['sine', 10, 0.04, 0.03],
    ],
    attack: 0.003,
    decay: 0.25,
    sustain: 0.06,
    release: 0.15,
    glide: 0,
    cutoff: [1500, 5000],
    send: 0.2,
    sendOpen: 0.5,
    pad: { wave: 'sawtooth', level: 0.035, detune: 6 },
    room: 1.6,
    wet: 0.25,
    gain: 1.3, // rendered 3.2 dB quieter; not all the way back, the limiter would work too hard
  },
};

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** Two seconds of decaying stereo noise: a room, built here so no file is fetched. */
function impulse(ctx: BaseAudioContext, seconds = 2.2): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  // A fixed sequence, so an offline render is the same every time.
  let s = 0x2545f491;
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const noise = ((s >>> 0) / 4294967296) * 2 - 1;
      data[i] = noise * (1 - i / length) ** 3;
    }
  }
  return buffer;
}

export type Synth = {
  play(e: NoteEvent, at: number): void;
  /** Fade out and detach this voice's whole chain; anything still scheduled goes with it. */
  release(): void;
};

export function createSynth(ctx: BaseAudioContext, out: AudioNode = ctx.destination, timbre: Preset['timbre'] = 'pluck'): Synth {
  const v = TIMBRES[timbre];
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.ratio.value = 3;
  // Makeup gain after compression: renders peaked near -10 dBFS without it, thin on a phone
  // speaker. The equal-power panner takes 3 dB off a centred voice, so this is higher than
  // a mono chain would need — and 3.1 clipped dense two-finger passages, hence the limiter.
  const master = ctx.createGain();
  master.gain.value = 2.7 * v.gain;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  const output = ctx.createGain();
  compressor.connect(master).connect(limiter).connect(output).connect(out);
  const dry = ctx.createGain();
  dry.gain.value = 0.9;
  dry.connect(compressor);
  const reverb = ctx.createConvolver();
  reverb.buffer = impulse(ctx, v.room);
  const wet = ctx.createGain();
  wet.gain.value = v.wet;
  reverb.connect(wet).connect(compressor);

  const route = (node: AudioNode, send: number, pan: number) => {
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    node.connect(panner).connect(dry);
    const s = ctx.createGain();
    s.gain.value = send;
    panner.connect(s).connect(reverb);
  };

  function lead(e: NoteEvent, at: number) {
    const end = at + e.duration / 1000;
    const held = Math.max(at + v.attack + v.decay + 0.01, end);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = v.cutoff[0] + e.brightness * v.cutoff[1];
    filter.Q.value = 0.6;
    const env = ctx.createGain();
    const peak = 0.2 * e.velocity;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(peak, at + v.attack);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * v.sustain), at + v.attack + v.decay);
    env.gain.setTargetAtTime(0.0001, held, v.release);
    filter.connect(env);
    route(env, v.send + v.sendOpen * e.width, e.pan);
    // Openness brings out the overtones: a richer tone, not a louder one.
    for (const [type, ratio, level, open] of v.partials) {
      const gain = level + open * e.width;
      if (gain <= 0) continue;
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = hz(e.pitch) * ratio;
      if (v.glide) {
        osc.detune.setValueAtTime(v.glide, at);
        osc.detune.linearRampToValueAtTime(0, at + 0.12);
      }
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g).connect(filter);
      osc.start(at);
      osc.stop(held + v.release * 6);
    }
  }

  function pad(e: NoteEvent, at: number) {
    const end = at + e.duration / 1000;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 450 + e.brightness * 900;
    const env = ctx.createGain();
    const level = v.pad.level * e.velocity;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(level, at + 0.9);
    env.gain.setTargetAtTime(0.0001, Math.max(at + 0.9, end - 0.2), 0.5);
    filter.connect(env);
    route(env, 0.5 + 0.4 * e.width, e.pan);
    for (const cents of v.pad.detune ? [-v.pad.detune, v.pad.detune] : [0]) {
      const osc = ctx.createOscillator();
      osc.type = v.pad.wave;
      osc.frequency.value = hz(e.pitch);
      osc.detune.value = cents;
      osc.connect(filter);
      osc.start(at);
      osc.stop(Math.max(at + 0.9, end) + 2.5);
    }
  }

  return {
    play: (e, at) => (e.voice === 'pad' ? pad(e, at) : lead(e, at)),
    release() {
      // Fade rather than cut, then let go, so the graph does not grow with every 重来.
      output.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      setTimeout(() => output.disconnect(), 400);
    },
  };
}
