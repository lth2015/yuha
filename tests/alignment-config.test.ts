/**
 * An http aligner with part of its field mapping missing is a configuration
 * error, reported at start (apps/api/src/config.ts).
 *
 * It used not to be: the check appended its problem after the list had
 * already been thrown, so an incomplete mapping started silently and every
 * alignment failed one song at a time instead.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '@yuha/api';

const full = {
  ALIGNMENT_ADAPTER: 'http',
  ALIGNMENT_PROVIDER_ID: 'spark-whisper',
  ALIGNMENT_BASE_URL: 'http://127.0.0.1:8000',
  ALIGNMENT_API_KEY: 'k',
  ALIGNMENT_SUBMIT_PATH: '/v1/align',
  ALIGNMENT_LINES_FIELD: 'lines',
  ALIGNMENT_LINE_TEXT_FIELD: 'text',
  ALIGNMENT_LINE_START_FIELD: 'start',
  ALIGNMENT_LINE_END_FIELD: 'end',
};

function alignmentProblems(env: Record<string, string>): string[] {
  try {
    loadConfig({ DATABASE_URL: 'mysql://u:p@localhost:3306/x', ...env } as never);
    return [];
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return err.problems.filter((p) => /ALIGNMENT/.test(p));
  }
}

describe('the http aligner’s settings', () => {
  it('start when every required field is there', () => {
    expect(alignmentProblems(full)).toEqual([]);
  });

  it('refuse to start with any one of them missing, and say which', () => {
    for (const key of Object.keys(full).filter((k) => k !== 'ALIGNMENT_ADAPTER')) {
      const env: Record<string, string> = { ...full };
      delete env[key];
      expect(alignmentProblems(env), key).toEqual([expect.stringContaining(key)]);
    }
  });
});
