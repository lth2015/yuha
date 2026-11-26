// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
// The router belongs to the web workspace, not the root test package.
import { MemoryRouter } from '../apps/web/node_modules/react-router-dom';
import { I18nProvider, loadAllLangs } from '../apps/web/src/lib/i18n.js';
import { SceneMv } from '../apps/web/src/components/SceneMv.js';
import {
  defaultSceneClip,
  normalizeSceneList,
  type SceneMvClient,
  type SceneMvJob,
} from '../apps/web/src/lib/scene-mv.js';
import { ApiError } from '../apps/web/src/lib/api.js';

const playerMock = vi.hoisted(() => ({
  activeId: null as string | null, status: 'paused', duration: 120,
  play: vi.fn(), seek: vi.fn(), toggle: vi.fn(), onTime: vi.fn((_callback?: (seconds: number) => void) => () => {}),
}));
vi.mock('../apps/web/src/lib/player.js', () => ({
  usePlayer: () => playerMock,
  formatTime: (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`,
}));
await loadAllLangs();
const song = {
  trackId: 'song-a',
  title: 'Synthetic seaside song',
  durationSeconds: 120,
  previewUrl: null,
  lyricTimings: null,
};
const makeJob = (status: SceneMvJob['status'], extra: Partial<SceneMvJob> = {}): SceneMvJob => ({
  id: 'mv-a',
  trackId: 'song-a',
  status,
  style: 'seaside_sunset',
  clipStart: 40,
  clipEnd: 70,
  shots: [0, 1, 2, 3].map((idx) => ({
    idx,
    prompt: `Original fictional landscape ${idx}`,
    status: 'pending',
  })),
  drawn: 0,
  total: 4,
  aheadOfYou: 2,
  ...extra,
});
let host: HTMLDivElement;
let root: Root;
let client: SceneMvClient;
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
async function mount(currentSong: typeof song | (Omit<typeof song, 'previewUrl'> & { previewUrl: string }) = song) {
  await act(async () =>
    root.render(
      createElement(
        MemoryRouter,
        {},
        createElement(I18nProvider, { initialLang: 'en' }, createElement(SceneMv, { song: currentSong, client })),
      ),
    ),
  );
  await flush();
}
function button(text: string) {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button: ${text}\n${host.textContent}`);
  return found;
}
async function click(text: string) {
  await act(async () => button(text).click());
  await flush();
}
beforeEach(() => {
  vi.clearAllMocks(); playerMock.activeId = null; playerMock.status = 'paused';
  playerMock.onTime.mockImplementation(() => () => {});
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  client = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => makeJob('queued')),
    create: vi.fn(async () => makeJob('draft')),
    patch: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    download: vi.fn(async () => ({
      url: 'https://example.test/video.mp4',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    remove: vi.fn(async () => undefined),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('scene MV selection and restoration', () => {
  it('previews only this song rather than inheriting a previous library queue', async () => {
    await mount({ ...song, previewUrl: 'https://example.test/synthetic.mp3' });
    await click('Listen to this clip');
    expect(playerMock.play).toHaveBeenCalledWith(
      expect.objectContaining({ trackId: song.trackId }),
      [expect.objectContaining({ trackId: song.trackId })],
    );
  });
  it('stops the old preview when the selected window changes', async () => {
    await mount({ ...song, previewUrl: 'https://example.test/synthetic.mp3' });
    await click('Listen to this clip');
    playerMock.activeId = song.trackId; playerMock.status = 'playing';
    const field = host.querySelector<HTMLInputElement>('#scene-mv-start')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '30');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(playerMock.toggle).toHaveBeenCalledTimes(1);
    expect(button('Listen to this clip')).toBeTruthy();
  });
  it('leaves preview mode when the shared player reaches the end or is paused', async () => {
    const currentSong = { ...song, previewUrl: 'https://example.test/synthetic.mp3' };
    await mount(currentSong); await click('Listen to this clip');
    playerMock.activeId = song.trackId; playerMock.status = 'playing';
    await mount(currentSong);
    playerMock.status = 'paused'; await mount(currentSong);
    expect(button('Listen to this clip')).toBeTruthy();
  });
  it('pauses once when consecutive clock frames reach the selected end', async () => {
    let frame!: (seconds: number) => void;
    playerMock.onTime.mockImplementation((callback) => { frame = callback!; return () => {}; });
    const currentSong = { ...song, previewUrl: 'https://example.test/synthetic.mp3' };
    await mount(currentSong); await click('Listen to this clip');
    playerMock.activeId = song.trackId; playerMock.status = 'playing'; await mount(currentSong);
    await act(async () => { frame(76); frame(76.1); });
    expect(playerMock.toggle).toHaveBeenCalledTimes(1);
  });
  it('selects the chorus, otherwise the middle, within the song and 32-second limit', () => {
    expect(defaultSceneClip(120, null)).toEqual({ clipStart: 45, clipEnd: 75 });
    expect(
      defaultSceneClip(120, {
        source: 'aligned',
        lines: [{ text: 'Hello', section: 'chorus', start: 100, end: 110 }],
      }),
    ).toEqual({ clipStart: 90, clipEnd: 120 });
    expect(defaultSceneClip(12, null)).toEqual({ clipStart: 0, clipEnd: 12 });
  });
  it('does not turn an invalid list into a false empty-state', () => {
    expect(normalizeSceneList({ items: [makeJob('ready')] })).toHaveLength(1);
    expect(() => normalizeSceneList({ error: 'not a list' })).toThrow();
  });
  it('restores an active job ahead of a newer draft when returning to the song', async () => {
    client.list = vi.fn(async () => [makeJob('draft', { id: 'new-draft' }), makeJob('generating')]);
    await mount();
    expect(host.textContent).toContain('Generating your scenes');
    expect(host.textContent).toContain('You can leave this page');
    expect(client.create).not.toHaveBeenCalled();
  });
  it('requires explicit storyboard confirmation and saves edits before starting', async () => {
    await mount();
    await click('Plan my scenes');
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(client.start).not.toHaveBeenCalled();
    await click('Confirm and generate');
    expect(client.patch).toHaveBeenCalledWith(
      'mv-a',
      expect.arrayContaining(['Original fictional landscape 0']),
    );
    expect(client.start).toHaveBeenCalledTimes(1);
  });
  it('does not start a restored draft when the API omitted its prompts', async () => {
    client.list = vi.fn(async () => [makeJob('draft', { shots: [{ idx: 0, status: 'pending' }] })]);
    await mount();
    expect(host.textContent).toContain('Rebuild the storyboard');
    expect(host.querySelector('textarea')).toBeNull();
    expect(client.start).not.toHaveBeenCalled();
  });
  it('offers the existing job after the server refuses a second active task', async () => {
    client.start = vi.fn(async () => {
      throw new ApiError('CONFLICT', 'busy', 409, { activeId: 'other-mv' });
    });
    await mount();
    await click('Plan my scenes');
    await click('Confirm and generate');
    expect(host.textContent).toContain('You already have a video in progress');
    expect(button('View that video')).toBeTruthy();
  });
  it('maps failures to safe copy and never renders raw server text', async () => {
    client.list = vi.fn(async () => [makeJob('failed', { failure: 'private provider message with prompt' })]);
    await mount();
    expect(host.textContent).not.toContain('private provider message');
    expect(host.textContent).toContain('No song credits were used');
    expect(button('Start again')).toBeTruthy();
  });
  it('pauses polling while hidden and refreshes immediately on return', async () => {
    vi.useFakeTimers();
    client.list = vi.fn(async () => [makeJob('generating')]);
    await mount();
    const before = vi.mocked(client.get).mock.calls.length;
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => vi.advanceTimersByTimeAsync(36_000));
    expect(client.get).toHaveBeenCalledTimes(before);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flush();
    expect(vi.mocked(client.get).mock.calls.length).toBeGreaterThan(before);
  });
  it('does not duplicate a creation on two synchronous taps', async () => {
    let finish!: (job: SceneMvJob) => void;
    client.create = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await mount();
    await act(async () => {
      button('Plan my scenes').click();
      button('Plan my scenes').click();
    });
    expect(client.create).toHaveBeenCalledTimes(1);
    await act(async () => finish(makeJob('draft')));
  });
  it('does not let a late progress response undo a confirmed cancellation', async () => {
    vi.useFakeTimers();
    client.list = vi.fn(async () => [makeJob('generating')]);
    let late!: (job: SceneMvJob) => void;
    client.get = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            late = resolve;
          }),
      )
      .mockResolvedValue(makeJob('cancelled'));
    await mount();
    await act(async () => vi.advanceTimersByTimeAsync(12_000));
    await click('Cancel generation');
    expect(host.textContent).toContain('Generation cancelled');
    await act(async () => late(makeJob('generating')));
    expect(host.textContent).toContain('Generation cancelled');
    expect(client.cancel).toHaveBeenCalledTimes(1);
  });
  it('keeps an emptied scene editable but disables starting until it has words', async () => {
    client.list = vi.fn(async () => [makeJob('draft')]);
    await mount();
    const field = host.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('textarea')).toHaveLength(4);
    expect(button('Confirm and generate').disabled).toBe(true);
  });
  it('keeps unsaved storyboard edits when returning from another tab', async () => {
    client.list = vi.fn(async () => [makeJob('draft')]);
    client.get = vi.fn(async () => makeJob('draft'));
    await mount();
    const field = host.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'My unsaved fictional scene');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    for (const state of ['hidden', 'visible']) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    }
    await flush();
    expect(host.querySelector('textarea')?.value).toBe('My unsaved fictional scene');
  });
  it('does not offer a signed download for an expired result', async () => {
    client.list = vi.fn(async () => [
      makeJob('ready', { expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    ]);
    await mount();
    expect(host.textContent).toContain('storage period has ended');
    expect(client.download).not.toHaveBeenCalled();
    expect(host.querySelector('a[download]')).toBeNull();
  });
  it('explains the limit when a restored server prompt is too long to confirm', async () => {
    client.list = vi.fn(async () => [makeJob('draft', { shots: [{ idx: 0, prompt: 'x'.repeat(301) }] })]);
    await mount();
    expect(host.textContent).toContain('300 characters');
    expect(button('Confirm and generate').disabled).toBe(true);
  });
  it('keeps a previous result reachable after a newer job fails', async () => {
    const previous = makeJob('ready', {
      id: 'old-video',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    client.list = vi.fn(async () => [makeJob('failed'), previous]);
    client.get = vi.fn(async () => previous);
    await mount();
    const select = host.querySelector<HTMLSelectElement>('#scene-mv-history');
    expect(select).not.toBeNull();
    await act(async () => {
      select!.value = 'old-video';
      select!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(host.textContent).toContain('Your scene MV is ready');
  });
  it('does not invite another start while the first start result is unconfirmed', async () => {
    client.start = vi.fn(async () => {
      throw new Error('connection lost after submission');
    });
    await mount();
    await click('Plan my scenes');
    await click('Confirm and generate');
    expect(button('Confirm and generate').disabled).toBe(true);
    expect(host.textContent).toContain('Refresh its status');
  });
  it('uses one downloaded MP4 for preview and download, without sending bearer credentials to storage', async () => {
    client.list = vi.fn(async () => [
      makeJob('ready', { expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }),
    ]);
    const fetch = vi.fn(
      async () => new Response('synthetic video', { headers: { 'content-type': 'video/mp4' } }),
    );
    vi.stubGlobal('fetch', fetch);
    const createObjectURL = vi.fn(() => 'blob:synthetic-scene');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    await mount();
    await flush();
    expect(host.querySelector('video')?.getAttribute('src')).toBe('blob:synthetic-scene');
    expect(host.querySelector('a[download]')?.getAttribute('href')).toBe('blob:synthetic-scene');
    expect(fetch).toHaveBeenCalledWith(
      'https://example.test/video.mp4',
      expect.objectContaining({ credentials: 'omit' }),
    );
  });
});
