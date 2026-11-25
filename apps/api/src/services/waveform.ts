import { spawn } from 'node:child_process';

/**
 * How loud the song is, moment by moment, for the lyric timing workspace
 * (docs/MV_LYRIC_SYNC_UX_SPEC.md, phase 1).
 *
 * Drawn from the mix, so it is the music's energy and not the voice: a peak is
 * where something got loud, which helps a person find the first beat of a
 * chorus by eye, and does not say where a word was sung. The page treats it as
 * a picture, never as a timing.
 *
 * Done here rather than in the browser: decoding a four-minute song on a phone
 * costs tens of megabytes, and the signed audio URL is on a storage host whose
 * CORS rules the page cannot rely on.
 */

/** Samples per second fed to the peak pass. Enough for a picture, small enough to be cheap. */
const RATE = 2000;
/** Peaks per second of song: a line of lyrics spans tens of them. */
const PEAKS_PER_SECOND = 20;
const TIMEOUT_MS = 20_000;

/** The loudest sample in each of `buckets` equal slices, scaled so the loudest is 1. */
export function peaksFromPcm(pcm: Int16Array, buckets: number): number[] {
  const n = Math.min(buckets, pcm.length);
  if (n <= 0) return [];
  const raw = new Array<number>(n).fill(0);
  for (let b = 0; b < n; b += 1) {
    const from = Math.floor((b * pcm.length) / n);
    const to = Math.floor(((b + 1) * pcm.length) / n);
    let max = 0;
    for (let i = from; i < to; i += 1) {
      const v = Math.abs(pcm[i]!);
      if (v > max) max = v;
    }
    raw[b] = max;
  }
  const top = Math.max(...raw);
  return raw.map((v) => (top > 0 ? Number((v / top).toFixed(2)) : 0));
}

/** Two at a time per process: each is a short ffmpeg decode. */
let running = 0;
export class WaveformBusyError extends Error {}

/** `load` reads the song only once a slot is free, so a refused request never holds a song in memory. */
export async function songPeaks(load: () => Promise<Buffer>): Promise<{ peaks: number[]; seconds: number }> {
  if (running >= 2) throw new WaveformBusyError('waveforms are being drawn');
  running += 1;
  try {
    const pcm = await decode(await load());
    const seconds = pcm.length / RATE;
    return { peaks: peaksFromPcm(pcm, Math.round(seconds * PEAKS_PER_SECOND)), seconds: Number(seconds.toFixed(2)) };
  } finally {
    running -= 1;
  }
}

function decode(audio: Buffer): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', String(RATE), '-f', 's16le', 'pipe:1'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-2000);
    });
    // ffmpeg may stop reading early on a file it cannot parse; that is its error to report, not a crash.
    child.stdin.on('error', () => undefined);
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-400)}`));
      const buf = Buffer.concat(chunks);
      // A fresh, aligned copy: Buffer.concat may hand back a slice of a shared pool at an odd offset.
      const out = new Int16Array(Math.floor(buf.length / 2));
      for (let i = 0; i < out.length; i += 1) out[i] = buf.readInt16LE(i * 2);
      resolve(out);
    });
    child.stdin.end(audio);
  });
}
