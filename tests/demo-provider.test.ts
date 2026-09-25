/**
 * Fixture selection in the demo music adapter.
 *
 * Why this file exists: the fixtures on a working copy are generated, not
 * tracked (`assets/fixtures/audio/` is gitignored; `scripts/make-audio-fixtures.mjs`
 * is the source of truth), so they can predate the script that writes them.
 * When they did — names without the `-<N>s` suffix the adapter parses — every
 * file measured as 30s, a 120s request silently drew a 30s file, and the only
 * report was `output_check_failed` on the job plus sixteen unrelated-looking
 * assertion failures downstream. The adapter knew the fixture was too short and
 * said nothing, so this pins the behaviour that makes it say so.
 *
 * No database: the adapter is exercised directly.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DemoMusicProvider } from '@yuha/providers';
import type { MusicIntent } from '@yuha/contracts';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yuha-demo-fixtures-'));
  // Deliberately only a short one, which is the situation being tested.
  await writeFile(join(dir, 'night_walk_calm-30s.mp3'), Buffer.alloc(4096));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function intent(durationSeconds: number): MusicIntent {
  return {
    scene: 'night_walk',
    mood: 'calm',
    energy: 0.4,
    tempoHint: 'slow',
    instruments: ['pad'],
    durationSeconds,
    vocalMode: 'instrumental',
    styles: ['ambient'],
    brief: 'a calm ambient pad',
    lyrics: null,
    title: null,
  };
}

const submit = (durationSeconds: number, requestKey: string) =>
  new DemoMusicProvider({ fixturesDir: dir, latencyMs: 0 }).submit({
    intent: intent(durationSeconds),
    requestKey,
    format: 'mp3',
  });

describe('demo fixture selection', () => {
  it('serves a request the fixtures can satisfy', async () => {
    const res = await submit(30, 'demo-fixture-ok');
    expect(res.status).toBe('submitted');
  });

  it('fails the request, naming the remedy, when no fixture is long enough', async () => {
    const res = await submit(120, 'demo-fixture-too-short');

    // Not 'submitted': accepting it would deliver 30 seconds of audio against a
    // 120-second request, which the output check then rejects for a reason that
    // says nothing about the actual cause.
    expect(res.status).toBe('failed');
    if (res.status !== 'failed') return;
    expect(res.code).toBe('demo_fixture_missing');
    // The message has to carry the remedy: the reader of this failure is a
    // developer whose generated fixtures are stale, and the fix is one command.
    expect(res.message).toContain('120s');
    expect(res.message).toContain('pnpm fixtures:audio');
  });
});
