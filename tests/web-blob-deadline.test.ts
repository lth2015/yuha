/**
 * The share video's download (apps/web/src/lib/api.ts, apiPostForBlob):
 * the deadline covers the body, not only the headers. A response that
 * started and then stalled left the button reading "making" for ever.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('apiPostForBlob', () => {
  it('gives up on a body that stalls after the headers', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: { signal: AbortSignal }) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 0, 0, 24]));
          init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'video/mp4' } });
    });
    const { apiPostForBlob, NetworkError } = await import('../apps/web/src/lib/api');
    await expect(apiPostForBlob('/v1/x', {}, 50)).rejects.toBeInstanceOf(NetworkError);
  });

  it('still returns a body that arrives', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const { apiPostForBlob } = await import('../apps/web/src/lib/api');
    expect((await apiPostForBlob('/v1/x', {}, 1000)).size).toBe(3);
  });
});
