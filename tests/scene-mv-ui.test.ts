// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SceneMv } from '../apps/web/src/components/SceneMv.js';
import { I18nProvider, loadAllLangs } from '../apps/web/src/lib/i18n.js';
import { PhotoVideo } from '../apps/web/src/components/PhotoVideo.js';
import { SessionProvider } from '../apps/web/src/lib/session.js';
import { Blob as NetworkBlob } from 'node:buffer';

const job = {
  id: 'mv-1', trackId: 'song-1', status: 'generating', style: 'neon_rain',
  clipStart: 45, clipEnd: 75, shots: [{ idx: 0, status: 'succeeded' }, { idx: 1, status: 'submitted' },
    { idx: 2, status: 'pending' }, { idx: 3, status: 'pending' }],
  drawn: 1, total: 4, othersInProgress: 2, failure: null, expiresAt: null, createdAt: '2026-11-26T00:00:00Z',
};
let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  await loadAllLangs();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function mount(extra = {}) {
  await act(async () => root.render(createElement(I18nProvider, { initialLang: 'en' },
    createElement(SceneMv, { trackId: 'song-1', title: 'A synthetic song', duration: 120, timings: null, ...extra }))));
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  expect(button, `button: ${text}`).toBeTruthy();
  await act(async () => button!.click());
}

it('recovers a server-side task when the owner returns, without creating another one', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    requests.push(`${init.method} ${path}`);
    return Response.json({ items: [job] });
  });
  await mount();
  expect(host.textContent).toContain('1 / 4');
  expect(host.textContent).toContain('Others are making videos too');
  expect(requests).toEqual(['GET /v1/tracks/song-1/scene-mvs']);
  expect(host.querySelector('textarea')).toBeNull();
});

it('pauses progress polling while the page is hidden and refreshes when it returns', async () => {
  vi.useFakeTimers();
  let hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  let reads = 0;
  vi.stubGlobal('fetch', async (path: string) => {
    if (path.includes('/tracks/')) return Response.json({ items: [job] });
    reads++;
    return Response.json({ ...job, drawn: 2 });
  });
  await mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
  expect(host.textContent).toContain('2 / 4 scenes drawn');
  hidden = true;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(36_000); });
  expect(reads).toBe(1);
  hidden = false;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(reads).toBe(2);
});

it('reconciles a lost start response without replaying the write', async () => {
  const draft = { ...job, status: 'draft', shots: [{ idx: 0, status: 'pending', prompt: 'A quiet sea' }] };
  let starts = 0;
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (path.endsWith('/start')) { starts++; throw new TypeError('connection lost after acceptance'); }
    if (path.includes('/tracks/')) return Response.json({ items: [draft] });
    return Response.json(init.method === 'PATCH' ? draft : { ...job, status: 'queued' });
  });
  await mount();
  await click('Confirm and generate');
  expect(starts).toBe(1);
  expect(host.textContent).toContain('Queued, waiting to begin');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it('requires saved lyric edits before queuing a draft', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ items: [{ ...job, status: 'draft', shots: [{ idx: 0, status: 'pending', prompt: 'A quiet sea' }] }] }));
  await mount({ timingsUnsaved: true });
  expect(host.textContent).toContain('Save changes in the lyric timing tool');
  expect([...host.querySelectorAll('button')].find((b) => b.textContent === 'Confirm and generate')?.disabled).toBe(true);
});

it('does not offer an expired video for download', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ items: [{ ...job, status: 'ready', expiresAt: '2000-01-01T00:00:00Z' }] }));
  await mount();
  expect(host.textContent).toContain('This video has expired');
  expect(host.textContent).not.toContain('Load preview and download');
});

it('never renders raw provider failure text and keeps the no-charge recovery action', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ items: [{ ...job, status: 'failed', failure: 'private upstream exception' }] }));
  await mount();
  expect(host.textContent).not.toContain('private upstream exception');
  expect(host.textContent).toContain('No song credits were spent');
  await click('Make another video');
  expect(host.querySelector('form')).toBeTruthy();
});

it('lets the owner audition the selected start through the existing song player', async () => {
  const onListen = vi.fn();
  vi.stubGlobal('fetch', async () => Response.json({ items: [] }));
  await mount({ onListen });
  await click('Listen from here');
  expect(onListen).toHaveBeenCalledWith(45);
});

it('does not let a delayed list refresh overwrite a successful cancellation', async () => {
  let lists = 0;
  let finishRefresh!: (r: Response) => void;
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (init.method === 'POST') return Response.json({ ...job, status: 'cancelled' });
    if (path.includes('/tracks/')) {
      if (++lists === 2) return new Promise<Response>((resolve) => { finishRefresh = resolve; });
      return Response.json({ items: [job] });
    }
    return Response.json(job);
  });
  await mount();
  await click('Refresh progress');
  await click('Cancel generation');
  await act(async () => { finishRefresh(Response.json({ items: [job] })); });
  expect(host.textContent).toContain('Generation cancelled. No song credits were spent.');
  expect(host.textContent).not.toContain('Drawing scene');
});

it('keeps unsubmitted storyboard edits across both video folds without reopening the inner fold', async () => {
  const draft = { ...job, status: 'draft', shots: [{ idx: 0, status: 'pending', prompt: 'An original coastline' }] };
  vi.stubGlobal('fetch', async (path: string) => Response.json(path === '/v1/runtime' ? { features: {} } : { items: [draft] }));
  await act(async () => root.render(createElement(I18nProvider, { initialLang: 'en' }, createElement(SessionProvider, null,
    createElement(PhotoVideo, {
      song: { trackId: 'song-1', title: 'A synthetic song', durationSeconds: 120, coverSeed: 1, styles: [], dedication: null },
      labels: { site: 'YUHA' }, lyrics: null, lyricTimings: null, photosEnabled: false,
      makeCoverVideo: async () => new File([], 'unused.mp4'),
      sceneMv: (visible: boolean) => createElement(SceneMv, { trackId: 'song-1', title: 'A synthetic song', duration: 120, timings: null, visible }),
    })))));
  await act(async () => host.querySelector<HTMLButtonElement>('.photo-video__open')!.click());
  const details = host.querySelector<HTMLDetailsElement>('.scene-mv-entry')!;
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); });
  const textarea = host.querySelector<HTMLTextAreaElement>('.scene-mv textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'My edited coastline');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { details.open = false; details.dispatchEvent(new Event('toggle')); });
  await act(async () => host.querySelector<HTMLButtonElement>('.photo-video__head button')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('.photo-video__open')!.click());
  expect(host.querySelector<HTMLDetailsElement>('.scene-mv-entry')!.open).toBe(false);
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); });
  expect(host.querySelector<HTMLTextAreaElement>('.scene-mv textarea')!.value).toBe('My edited coastline');
});

it('shows a four-shot draft for confirmation before it queues any video work', async () => {
  const writes: { path: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (init.method === 'GET') return Response.json({ items: [] });
    writes.push({ path, body: JSON.parse(init.body as string) });
    return Response.json({ ...job, status: 'draft', drawn: 0,
      shots: [0, 1, 2, 3].map((idx) => ({ idx, status: 'pending', prompt: `An original seaside scene ${idx + 1}` })) });
  });
  await mount();
  await click('Plan four scenes');
  expect(writes).toEqual([{ path: '/v1/tracks/song-1/scene-mvs',
    body: { clipStart: 45, clipEnd: 75, style: 'neon_rain', description: '' } }]);
  expect(host.querySelectorAll('textarea')).toHaveLength(4);
  expect(host.textContent).toContain('Confirm and generate');
});

it('saves the reviewed storyboard before starting and shows the server queue state', async () => {
  const writes: string[] = [];
  const draft = { ...job, status: 'draft', drawn: 0, shots: [0, 1, 2, 3].map((idx) => ({ idx, status: 'pending', prompt: `Scene ${idx}` })) };
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (init.method === 'GET') return Response.json({ items: [draft] });
    writes.push(`${init.method} ${path}`);
    return Response.json(init.method === 'PATCH' ? draft : { ...draft, status: 'queued' });
  });
  await mount();
  await click('Confirm and generate');
  expect(writes).toEqual(['PATCH /v1/scene-mvs/mv-1', 'POST /v1/scene-mvs/mv-1/start']);
  expect(host.textContent).toContain('Queued, waiting to begin');
  expect(host.textContent).toContain('You can leave; work continues');
});

it('cancels an active task using its real server state, with an honest in-flight scene warning', async () => {
  const writes: string[] = [];
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (init.method === 'GET') return Response.json({ items: [job] });
    writes.push(`${init.method} ${path}`);
    return Response.json({ ...job, status: 'cancelled' });
  });
  await mount();
  expect(host.textContent).toContain('A scene already running on the machine will still finish');
  await click('Cancel generation');
  expect(writes).toEqual(['POST /v1/scene-mvs/mv-1/cancel']);
  expect(host.textContent).toContain('Generation cancelled. No song credits were spent.');
});

it('handles another active MV as a recoverable conflict and links to its actual song', async () => {
  const draft = { ...job, status: 'draft', shots: [{ idx: 0, status: 'pending', prompt: 'A quiet sea' }] };
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (path.endsWith('/start')) return Response.json({ error: { code: 'CONFLICT', message: 'busy', details: { reason: 'busy', activeId: 'other-mv' } } }, { status: 409 });
    if (path.endsWith('/other-mv')) return Response.json({ ...job, id: 'other-mv', trackId: 'other-song' });
    return Response.json(init.method === 'GET' ? { items: [draft] } : draft);
  });
  await mount();
  await click('Confirm and generate');
  expect(host.textContent).toContain('Another scene MV is already in progress');
  await click('View the active MV');
  expect(host.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toBe('/song/other-song?video=1');
});

it.each(['video/mp4', 'audio/mpeg'])('loads a signed MP4 file even when storage labels it %s, without forwarding the account token', async (type) => {
  const binaryRequests: RequestInit[] = [];
  // jsdom's legacy Blob lacks text(); network responses use the modern Web Blob API.
  vi.stubGlobal('Blob', NetworkBlob);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:scene-mv'), revokeObjectURL: vi.fn() }));
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (path === 'https://files.example.test/signed.mp4') {
      binaryRequests.push(init);
      return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]), { headers: { 'content-type': type } });
    }
    if (path.endsWith('/download')) return Response.json({ url: 'https://files.example.test/signed.mp4', expiresAt: '2099-11-26T00:10:00Z' });
    return Response.json({ items: [{ ...job, status: 'ready', drawn: 4, expiresAt: '2099-12-03T00:00:00Z' }] });
  });
  await mount();
  expect(host.textContent).toContain('2099');
  await click('Load preview and download');
  expect(host.querySelector('video')?.getAttribute('src')).toBe('blob:scene-mv');
  expect(host.querySelector('a[download]')?.getAttribute('href')).toBe('blob:scene-mv');
  expect(binaryRequests[0]).toMatchObject({ credentials: 'omit' });
  expect(binaryRequests[0]?.headers).toBeUndefined();
});

it('refuses a proxy HTML page even if it is labelled as a successful video response', async () => {
  vi.stubGlobal('Blob', NetworkBlob);
  vi.stubGlobal('fetch', async (path: string) => {
    if (path === 'https://files.example.test/bad') return new Response('<!doctype html><title>error</title>', { headers: { 'content-type': 'video/mp4' } });
    if (path.endsWith('/download')) return Response.json({ url: 'https://files.example.test/bad' });
    return Response.json({ items: [{ ...job, status: 'ready', expiresAt: '2099-12-03T00:00:00Z' }] });
  });
  await mount(); await click('Load preview and download');
  expect(host.querySelector('video')).toBeNull();
  expect(host.querySelector('a[download]')).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('The video could not be loaded');
});

it('pauses the scene preview when its video section is folded', async () => {
  vi.stubGlobal('Blob', NetworkBlob);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:scene-mv'), revokeObjectURL: vi.fn() }));
  const paused = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.stubGlobal('fetch', async (path: string) => {
    if (path === 'https://files.example.test/video') return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { headers: { 'content-type': 'video/mp4' } });
    if (path.endsWith('/download')) return Response.json({ url: 'https://files.example.test/video' });
    return Response.json({ items: [{ ...job, status: 'ready', expiresAt: '2099-12-03T00:00:00Z' }] });
  });
  await mount(); await click('Load preview and download');
  expect(host.querySelector('video')).toBeTruthy();
  await mount({ visible: false });
  expect(paused).toHaveBeenCalled();
  expect(host.querySelector('a[download]')).toBeTruthy();
});
