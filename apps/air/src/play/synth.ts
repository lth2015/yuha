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

export type Synth = { play(e: NoteEvent, at: number): void };

export function createSynth(ctx: BaseAudioContext, out: AudioNode = ctx.destination): Synth {
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.ratio.value = 3;
  // Makeup gain after compression: renders peaked near -10 dBFS without it, thin on a phone
  // speaker. The equal-power panner takes 3 dB off a centred voice, so this is higher than
  // a mono chain would need — and 3.1 clipped dense two-finger passages, hence the limiter.
  const master = ctx.createGain();
  master.gain.value = 2.7;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  compressor.connect(master).connect(limiter).connect(out);
  const dry = ctx.createGain();
  dry.gain.value = 0.9;
  dry.connect(compressor);
  const reverb = ctx.createConvolver();
  reverb.buffer = impulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.32;
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
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700 + e.brightness * 4300;
    filter.Q.value = 0.6;
    const env = ctx.createGain();
    const peak = 0.2 * e.velocity;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(peak, at + 0.008);
    env.gain.exponentialRampToValueAtTime(peak * 0.35, at + 0.35);
    env.gain.setTargetAtTime(0.0001, Math.max(at + 0.36, end), 0.25);
    filter.connect(env);
    route(env, 0.25 + 0.6 * e.width, e.pan);
    // Openness brings out the overtones: a richer tone, not a louder one.
    for (const [type, ratio, level] of [
      ['triangle', 1, 1],
      ['sine', 2, 0.18 + 0.22 * e.width],
      ['sine', 3, 0.1 * e.width],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = hz(e.pitch) * ratio;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(filter);
      osc.start(at);
      osc.stop(Math.max(at + 0.36, end) + 1.5);
    }
  }

  function pad(e: NoteEvent, at: number) {
    const end = at + e.duration / 1000;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 450 + e.brightness * 900;
    const env = ctx.createGain();
    const level = 0.045 * e.velocity;
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(level, at + 0.9);
    env.gain.setTargetAtTime(0.0001, Math.max(at + 0.9, end - 0.2), 0.5);
    filter.connect(env);
    route(env, 0.5 + 0.4 * e.width, e.pan);
    for (const cents of [-6, 6]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = hz(e.pitch);
      osc.detune.value = cents;
      osc.connect(filter);
      osc.start(at);
      osc.stop(Math.max(at + 0.9, end) + 2.5);
    }
  }

  return { play: (e, at) => (e.voice === 'pad' ? pad(e, at) : lead(e, at)) };
}
