import { describe, expect, it, vi } from 'vitest';
import { makeLogger } from '@yuha/worker/loops';

describe('worker logging', () => {
  it('keeps the error but removes credential-bearing URLs', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      makeLogger('worker')('error', 'stablecoin scan pass failed', {
        err: 'Request failed at https://rpc.example.com/private-key\nplan unavailable',
      });
      const line = output.mock.calls[0]?.[0] as string;
      const entry = JSON.parse(line) as { component: string; msg: string; err: string };
      expect(entry).toMatchObject({
        component: 'worker',
        msg: 'stablecoin scan pass failed',
        err: 'Request failed at [redacted-url]\nplan unavailable',
      });
      expect(line).not.toContain('private-key');
    } finally {
      output.mockRestore();
    }
  });
});
