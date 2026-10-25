/**
 * Turns note events into sound. Takes any BaseAudioContext, so the same voices
 * play live and render offline (the listening recordings for #28 are made
 * that way, so what is approved is what plays).
 *
 * Two voices: a soft plucked lead whose brightness follows height, and a slow
 * pad under it. Both go to a little generated reverb and a gentle compressor,
 * so many notes at once stay a texture instead of getting loud.
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
  // Makeup gain after compression: renders peaked near -10 dBFS without it, thin on a phone speaker.
  const master = ctx.createGain();
  master.gain.value = 2.2;
  compressor.connect(master).connect(out);
  const dry = ctx.createGain();
  dry.gain.value = 0.9;
  dry.connect(compressor);
  const reverb = ctx.createConvolver();
  reverb.buffer = impulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.32;
  reverb.connect(wet).connect(compressor);

  const route = (node: AudioNode, send: number) => {
    node.connect(dry);
    const s = ctx.createGain();
    s.gain.value = send;
    node.connect(s).connect(reverb);
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
    route(env, 0.35);
    for (const [type, ratio, level] of [
      ['triangle', 1, 1],
      ['sine', 2, 0.18],
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
    route(env, 0.6);
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

  return { play: (e, at) => (e.voice === 'lead' ? lead(e, at) : pad(e, at)) };
}
