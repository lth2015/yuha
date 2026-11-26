/**
 * The loop that takes an automatic lyric sync onto every open view of a song
 * (apps/web/src/lib/lyric-sync-refresh.ts; Codex review of PR #157).
 *
 * Pinned with a fake clock and a fake page: it asks only while the page is in
 * front, asks again when the page comes back, drops an answer that arrives
 * after the view has moved to another song, hands the result to the other
 * views of the song, and never does anything but replace the lyric fields.
 * Whether playback carries on across the swap is a browser fact, checked in a
 * browser (PR #157 description), not here.
 */
import { describe, expect, it, vi } from 'vitest';
import { LYRIC_SYNC_POLL_MS, startLyricSyncRefresh, type LyricSyncUpdate, type RefreshEnv } from '../apps/web/src/lib/lyric-sync-refresh';

function fakePage() {
  let visible = true;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const listeners = new Set<() => void>();
  const broadcasts: LyricSyncUpdate[] = [];
  const answers: Array<(u: LyricSyncUpdate) => void> = [];
  const asked: string[] = [];
  const env: RefreshEnv = {
    fetchTrack: (id) => {
      asked.push(id);
      return new Promise((resolve) => answers.push(resolve));
    },
    isVisible: () => visible,
    setInterval: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearInterval: (h) => {
      const i = timers.indexOf(h as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    onVisible: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    broadcast: (u) => broadcasts.push(u),
  };
  return {
    env,
    asked,
    answers,
    broadcasts,
    tick: () => timers.forEach((t) => t.fn()),
    hide: () => (visible = false),
    show: () => {
      visible = true;
      listeners.forEach((l) => l());
    },
    timers,
  };
}

const synced = (trackId: string): LyricSyncUpdate => ({
  trackId,
  lyricSync: 'synced',
  lyricTimings: { source: 'aligned', aligner: 'mms-fa', lines: [{ text: 'a', section: '', start: 1, end: 2 }] },
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the automatic lyric refresh', () => {
  it('asks every 12 s while the page is in front, and once more when it comes back', () => {
    const p = fakePage();
    startLyricSyncRefresh('A', () => undefined, p.env);
    expect(p.timers[0]!.ms).toBe(LYRIC_SYNC_POLL_MS);
    p.tick();
    expect(p.asked).toEqual(['A']);
    p.hide();
    p.tick();
    expect(p.asked).toEqual(['A']); // hidden: nothing asked
    p.show();
    expect(p.asked).toEqual(['A', 'A']); // back in front: asked at once
  });

  it('applies the timeline and tells the song’s other views', async () => {
    const p = fakePage();
    const applied = vi.fn();
    startLyricSyncRefresh('A', applied, p.env);
    p.tick();
    p.answers[0]!(synced('A'));
    await flush();
    expect(applied).toHaveBeenCalledWith(synced('A'));
    expect(p.broadcasts).toEqual([synced('A')]);
  });

  it('drops an answer that arrives after the view moved to another song', async () => {
    const p = fakePage();
    const applied = vi.fn();
    const stopA = startLyricSyncRefresh('A', applied, p.env);
    p.tick(); // asks for A
    stopA(); // the view now shows B
    startLyricSyncRefresh('B', applied, p.env);
    p.answers[0]!(synced('A')); // A's late answer
    await flush();
    expect(applied).not.toHaveBeenCalled();
    expect(p.broadcasts).toEqual([]);
  });

  it('ignores an answer about a different song than it asked for', async () => {
    const p = fakePage();
    const applied = vi.fn();
    startLyricSyncRefresh('A', applied, p.env);
    p.tick();
    p.answers[0]!(synced('B'));
    await flush();
    expect(applied).not.toHaveBeenCalled();
  });

  it('stops asking once stopped, and a failed ask changes nothing', async () => {
    const p = fakePage();
    const applied = vi.fn();
    const env = { ...p.env, fetchTrack: () => Promise.reject(new Error('offline')) };
    const stop = startLyricSyncRefresh('A', applied, env);
    p.tick();
    await flush();
    expect(applied).not.toHaveBeenCalled();
    stop();
    expect(p.timers).toHaveLength(0);
  });
});
