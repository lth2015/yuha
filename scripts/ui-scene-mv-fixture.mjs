import { spawnSync } from 'node:child_process';

// Contract fixtures for UI measurement only. No server flag or GPU is touched.
let sample;
function videoSample() {
  if (!sample) {
    const out = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=0x8baca5:s=180x320:r=12',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=22050',
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        'frag_keyframe+empty_moov',
        '-f',
        'mp4',
        'pipe:1',
      ],
      { maxBuffer: 5_000_000 },
    );
    if (out.status !== 0) throw new Error('scene MV UI fixture: ffmpeg could not make synthetic preview');
    sample = out.stdout;
  }
  return sample;
}

export async function prepareSceneMv(page, state) {
  const origin = new URL(page.url()).origin;
  const trackId = new URL(page.url()).pathname.split('/').pop();
  let status = state === 'progress' ? 'generating' : state === 'history' ? 'failed' : state;
  const id = '11111111-2222-4333-8444-555555555555';
  const job = () => ({
    id,
    trackId,
    status,
    style: 'seaside_sunset',
    clipStart: 0,
    clipEnd: 30,
    shots: [0, 1, 2, 3].map((idx) => ({
      idx,
      prompt: 'Fictional coastline in warm evening light, a gentle movement towards the sea.',
      status: idx < 2 ? 'done' : 'pending',
    })),
    drawn: 2,
    total: 4,
    othersInProgress: 3,
    createdAt: new Date().toISOString(),
    failure: status === 'failed' ? 'shot_failed' : null,
    expiresAt: status === 'ready' ? new Date(Date.now() + 7 * 86_400_000).toISOString() : null,
  });
  const runtime = async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.features.sceneMv = true;
    await route.fulfill({ response: res, json: body });
  };
  const api = async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (path.endsWith('/download'))
      return route.fulfill({
        json: {
          url: `${origin}/__scene_mv_ui_sample.mp4`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    if (path.endsWith('/start')) {
      status = 'queued';
      return route.fulfill({ status: 202, json: {} });
    }
    if (path.endsWith('/cancel')) {
      status = 'cancelled';
      return route.fulfill({ json: {} });
    }
    if (method === 'DELETE') {
      status = 'config';
      return route.fulfill({ status: 204 });
    }
    if (path.includes('/tracks/')) {
      if (method === 'POST') {
        status = 'draft';
        return route.fulfill({ status: 201, json: job() });
      }
      const items = status === 'config' ? [] : [job()];
      if (state === 'history') items.push({ ...job(), id: '22222222-3333-4444-8555-666666666666', status: 'cancelled', createdAt: new Date(Date.now() - 60_000).toISOString() });
      return route.fulfill({ json: { items } });
    }
    return route.fulfill({ json: job() });
  };
  const media = (route) => route.fulfill({ contentType: 'video/mp4', body: videoSample() });
  const routes = [
    ['**/v1/runtime*', runtime],
    ['**/v1/tracks/*/scene-mvs', api],
    ['**/v1/scene-mvs/**', api],
    ['**/__scene_mv_ui_sample.mp4', media],
  ];
  for (const [pattern, handler] of routes) await page.route(pattern, handler);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.scene-mv').waitFor();
  if (state === 'ready') await page.locator('.scene-mv video').waitFor();
  return async () => {
    for (const [pattern, handler] of routes) await page.unroute(pattern, handler);
  };
}
