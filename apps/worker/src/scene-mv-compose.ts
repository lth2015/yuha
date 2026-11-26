import { trustedTimeline } from '@yuha/contracts';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LyricTimings } from '@yuha/contracts';
import { advanceSceneMv, db, forgetShotClips, getMasterAsset, getSceneMv, getTrack, queryOne } from '@yuha/db';
import type { StorageAdapter } from '@yuha/providers';

/**
 * Composing a scene MV (docs/AI_SCENE_MV_TICKETS.md, T6; docs/AI_SCENE_MV_SPEC.md).
 *
 * The drawn shots, each held for an equal share of the chosen span and cut
 * on those beats; the song's own sound for that span and nothing else (the
 * shots are silent, and only the song's stream is mapped, so a shot that
 * somehow carried sound could not be heard); the lyrics as subtitles on the
 * timing the song has now; 720×1280.
 *
 * Kept privately for KEEP_DAYS — the spec's proposed default, not yet a
 * promise made to anyone — and the drawn shots are deleted either way: the
 * composed MV is the only copy anyone needs.
 *
 * One composition at a time across every worker: it is CPU, and the worker
 * does everything else too.
 */
export interface ComposeDeps {
  storage: StorageAdapter;
  owner: string;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  ffmpegPath?: string;
}

const KEEP_DAYS = 7;
const WIDTH = 720;
const HEIGHT = 1280;
const FPS = 24;
const TIMEOUT_MS = 5 * 60_000;
const FONT = 'Noto Sans CJK SC';

/** Composes the oldest MV waiting to be, if this worker can take the turn. Returns its id, or null. */
export async function composeNextSceneMv(d: ComposeDeps): Promise<string | null> {
  const conn = await db().getConnection();
  try {
    const got = await queryOne<{ ok: number | null }>(`SELECT GET_LOCK('yuha_scene_mv_compose', 0) AS ok`, [], conn);
    if (Number(got?.ok) !== 1) return null;
    try {
      const next = await queryOne<{ id: string }>(`SELECT id FROM scene_mvs WHERE status = 'composing' ORDER BY queued_at, id LIMIT 1`, [], conn);
      if (!next) return null;
      await composeOne(d, next.id);
      return next.id;
    } finally {
      await queryOne(`SELECT RELEASE_LOCK('yuha_scene_mv_compose')`, [], conn);
    }
  } finally {
    conn.release();
  }
}

async function composeOne(d: ComposeDeps, id: string): Promise<void> {
  const mv = await getSceneMv(id);
  if (!mv || mv.status !== 'composing') return;
  const track = await getTrack(mv.track_id);
  const master = track && !track.deleted_at && track.state === 'deliverable' ? await getMasterAsset(track.id) : undefined;
  if (!track || !master) {
    await advanceSceneMv(id, 'composing', 'failed', { failure: 'song_gone' });
    await dropShots(d, id);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'yuha-scene-mv-'));
  try {
    const span = mv.clip_end - mv.clip_start;
    const shots = mv.shots.filter((s) => s.status === 'succeeded' && s.clip_key).sort((a, b) => a.idx - b.idx);
    if (shots.length !== mv.shots.length || !shots.length) throw new Error('a shot is missing');
    for (const s of shots) await writeFile(join(dir, `shot-${s.idx}.mp4`), await d.storage.get('delivery', s.clip_key!));
    await writeFile(join(dir, 'song'), await d.storage.get('delivery', master.storage_key));
    const timings = track.vocal_mode !== 'instrumental' ? (track.lyric_timings as LyricTimings | null) : null;
    const trusted = subtitleLines(timings);
    const subs = trusted.length ? buildAss(trusted, mv.clip_start, mv.clip_end) : null;
    if (subs && subs.includes('Dialogue:')) await writeFile(join(dir, 'subs.ass'), subs);
    const withSubs = !!subs && subs.includes('Dialogue:');

    const seg = span / shots.length;
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    for (const s of shots) args.push('-i', `shot-${s.idx}.mp4`);
    args.push('-ss', String(mv.clip_start), '-t', String(span), '-i', 'song');
    const filters: string[] = [];
    shots.forEach((_, i) => {
      // Held a little past its end if the service drew it short, then cut on the beat.
      filters.push(
        `[${i}:v]tpad=stop_mode=clone:stop_duration=${seg.toFixed(3)},trim=duration=${seg.toFixed(3)},setpts=PTS-STARTPTS,` +
          `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},fps=${FPS},setsar=1[v${i}]`,
      );
    });
    filters.push(`${shots.map((_, i) => `[v${i}]`).join('')}concat=n=${shots.length}:v=1:a=0[vc]`);
    filters.push(withSubs ? `[vc]subtitles=filename=subs.ass[vout]` : `[vc]null[vout]`);
    const fadeOut = Math.max(0, span - 1);
    filters.push(`[${shots.length}:a]afade=t=in:d=0.3,afade=t=out:st=${fadeOut.toFixed(3)}:d=1[aout]`);
    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-t', span.toFixed(3), '-movflags', '+faststart', 'mv.mp4',
    );
    await ffmpeg(d.ffmpegPath ?? 'ffmpeg', args, dir);
    const key = `scene-mv/${mv.owner_id}/${id}/mv.mp4`;
    await d.storage.put({ zone: 'delivery', key, body: await readFile(join(dir, 'mv.mp4')), contentType: 'video/mp4' });
    const ok = await advanceSceneMv(id, 'composing', 'ready', { outputKey: key, expiresAt: new Date(Date.now() + KEEP_DAYS * 86_400_000) });
    if (!ok) await d.storage.remove('delivery', key).catch(() => undefined); // cancelled or deleted meanwhile
    d.log('info', 'scene mv composed', { sceneMvId: id, seconds: span, subtitles: withSubs });
  } catch (err) {
    await advanceSceneMv(id, 'composing', 'failed', { failure: 'compose_failed' });
    // Only how ffmpeg ended, not what it printed: libass can echo a subtitle line, which is a lyric.
    d.log('error', 'scene mv could not be composed', { sceneMvId: id, err: (err as Error).message.split(':')[0]!.slice(0, 80) });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await dropShots(d, id);
  }
}

/** The drawn shots are not kept past composition, whatever its outcome. */
async function dropShots(d: ComposeDeps, id: string): Promise<void> {
  const mv = await getSceneMv(id);
  for (const s of mv?.shots ?? []) {
    if (!s.clip_key) continue;
    try {
      await d.storage.remove('delivery', s.clip_key);
    } catch (err) {
      d.log('warn', 'a scene mv shot file would not delete', { key: s.clip_key, err: (err as Error).message.slice(0, 120) });
      continue;
    }
    await forgetShotClips(id, s.id);
  }
}

function ffmpeg(bin: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => (err = (err + String(c)).slice(-2000)));
    const timer = setTimeout(() => p.kill('SIGKILL'), TIMEOUT_MS);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${err.trim()}`));
    });
  });
}

const clock = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const sec = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

/**
 * The span's lyric lines as an ASS subtitle file, on the span's own clock,
 * cut at its edges. A lyric is text, never markup: the characters ASS gives
 * meaning to are replaced by their full-width look-alikes.
 */
/**
 * The lines a scene MV may burn in: only trusted ones (isTrustedLine). An
 * estimate burned into a video is the error a viewer keeps; a line the
 * aligner was unsure of is left out rather than shown at a guessed time.
 */
export function subtitleLines(timings: LyricTimings | null | undefined): LyricTimings['lines'] {
  return trustedTimeline(timings)?.lines ?? [];
}

export function buildAss(lines: LyricTimings['lines'], start: number, end: number): string {
  const events = lines
    .filter((l) => l.end > start && l.start < end && l.text.trim())
    .map((l) => {
      const text = l.text.replace(/\\/g, '＼').replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\s*\n\s*/g, ' ').trim();
      return `Dialogue: 0,${clock(Math.max(0, l.start - start))},${clock(Math.min(end, l.end) - start)},Default,,0,0,0,,${text}`;
    });
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${WIDTH}`,
    `PlayResY: ${HEIGHT}`,
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${FONT},44,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,180,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
}
