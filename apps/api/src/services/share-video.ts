import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A short portrait video of a song, for posting (docs/GIFT_AND_SHARE_SPEC.md).
 *
 * X, Instagram and TikTok play a video in the feed; a link is a line of text.
 * The owner's browser draws the frames — the sleeve, the title, who it is
 * for, each lyric line as it is sung — because it has the fonts and the
 * sleeve. This puts them on the song's own audio, adds a waveform that moves
 * with it, and returns an MP4. Nothing is stored: the bytes go straight back
 * to the phone that asked, which shares them as a file.
 */
export interface VideoFrame {
  /** Seconds from the start of the clip at which this frame appears. */
  at: number;
  jpeg: Buffer;
}

export const VIDEO_WIDTH = 720;
export const VIDEO_HEIGHT = 1280;
/** Where the frames leave room for the waveform (share-art.ts draws around it). */
const WAVE = { x: 80, y: 1072, w: 560, h: 96 };
const TIMEOUT_MS = 50_000;
// The JPEG concat input uses a 25 fps clock before the resample to 24 fps.
const FRAME_CLOCK = 25;

/** One encode at a time per process: it is CPU, and the API serves everything else too. */
let busy = false;
export class VideoBusyError extends Error {}

function run(args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-4000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

export async function renderShareVideo(params: {
  audio: Buffer;
  /** Where in the song the clip starts, seconds. */
  start: number;
  /** Clip length, seconds. */
  duration: number;
  frames: VideoFrame[];
}): Promise<Buffer> {
  if (busy) throw new VideoBusyError('another video is being made');
  busy = true;
  let dir: string | null = null;
  try {
    // Inside the try: a /tmp that will not make a directory must not leave
    // `busy` set, which would refuse every video on this pod until it restarts.
    dir = await mkdtemp(join(tmpdir(), 'yuha-video-'));
    // Quantize absolute times once. Stretching each short interval to a full
    // frame adds a delay to every following photo and caption. For cuts on the
    // same tick, the last picture describes the state after those cuts.
    const byTick = new Map<number, Buffer>();
    for (const frame of [...params.frames].sort((a, b) => a.at - b.at)) {
      const tick = Math.round(frame.at * FRAME_CLOCK);
      if (tick / FRAME_CLOCK < params.duration) byTick.set(tick, frame.jpeg);
    }
    const frames = [...byTick];
    const endTick = Math.ceil(params.duration * FRAME_CLOCK);
    const audioPath = join(dir, 'audio');
    await writeFile(audioPath, params.audio);
    // The concat demuxer: each frame lasts until the next one; the last is
    // listed twice, which is how that demuxer is told the final duration.
    const lines: string[] = [];
    for (let i = 0; i < frames.length; i += 1) {
      const name = `f${String(i).padStart(3, '0')}.jpg`;
      const [tick, jpeg] = frames[i]!;
      await writeFile(join(dir, name), jpeg);
      const until = frames[i + 1]?.[0] ?? endTick;
      lines.push(`file '${name}'`, `duration ${((until - tick) / FRAME_CLOCK).toFixed(3)}`);
    }
    lines.push(`file 'f${String(frames.length - 1).padStart(3, '0')}.jpg'`);
    await writeFile(join(dir, 'frames.txt'), lines.join('\n'));

    const out = join(dir, 'out.mp4');
    const fadeOut = Math.max(0, params.duration - 1.2).toFixed(2);
    const res = await run(
      [
        '-v', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt'),
        '-ss', params.start.toFixed(2), '-t', params.duration.toFixed(2), '-i', audioPath,
        '-filter_complex',
        `[0:v]scale=${VIDEO_WIDTH}:${VIDEO_HEIGHT},fps=24,format=yuv420p[bg];` +
          `[1:a]asplit[a1][a2];` +
          `[a2]showwaves=s=${WAVE.w}x${WAVE.h}:mode=cline:rate=24:colors=white@0.9,format=rgba[w];` +
          `[bg][w]overlay=${WAVE.x}:${WAVE.y}:shortest=1[v];` +
          `[a1]afade=t=in:d=0.4,afade=t=out:st=${fadeOut}:d=1.2[a]`,
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-crf', '24', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        '-t', params.duration.toFixed(2),
        '-threads', '2',
        out,
      ],
      TIMEOUT_MS,
    );
    if (res.code !== 0) throw new Error(`ffmpeg failed (${res.code}): ${res.stderr.slice(-400)}`);
    return await readFile(out);
  } finally {
    busy = false;
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Removes encode directories left behind by a process that died mid-encode.
 *
 * `renderShareVideo` deletes its directory in `finally`, which covers success,
 * an ffmpeg failure and the timeout, but not a crash or an OOM kill: then the
 * frames (people's photos, for a photo video) stay in the pod's /tmp until
 * the pod is replaced. The privacy text promises they are gone within a day,
 * so the API runs this at start and every hour. An hour is far past the
 * 50-second encode limit, so a directory still in use is never touched.
 */
export async function sweepStaleVideoDirs(opts: { root?: string; olderThanMs?: number; now?: number } = {}): Promise<number> {
  const root = opts.root ?? tmpdir();
  const cutoff = (opts.now ?? Date.now()) - (opts.olderThanMs ?? 3_600_000);
  let removed = 0;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!name.startsWith('yuha-video-')) continue;
    const path = join(root, name);
    try {
      if ((await stat(path)).mtimeMs >= cutoff) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* gone already, or another process's: the next sweep tries again */
    }
  }
  return removed;
}

/** JPEG bytes start FF D8 FF. */
export const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
