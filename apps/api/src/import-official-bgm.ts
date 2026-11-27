import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { closeDb } from '@yuha/db';
import { AudioProcessor } from '@yuha/providers';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { importOfficialBgm, inspectOfficialBgmSource, OFFICIAL_BGM_MAX_BYTES, officialBgmImportInput } from './services/official-bgm-import.js';

const manifest = z.object({
  batch: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,90}$/),
  tracks: z.array(z.object({
    id: z.string().regex(/^[a-z0-9]{1,16}$/),
    title: z.string(),
    bgm: z.object({ genre: z.string(), scenario: z.string(), mood: z.string() }),
    previewStartSeconds: z.number().optional(),
  })).min(1).max(30),
});
const results = z.object({
  tracks: z.record(z.object({ status: z.string(), file: z.string().optional() })),
});

async function main() {
  const { values } = parseArgs({ options: {
    dir: { type: 'string' }, only: { type: 'string' }, apply: { type: 'boolean' },
    'all-candidates': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (!values.dir || values.help) {
    console.log('pnpm marketplace:bgm --dir /absolute/batch/path [--only 01,02] [--apply | --apply --all-candidates]');
    return values.help ? 0 : 1;
  }
  if (values.apply && Boolean(values.only) === Boolean(values['all-candidates'])) {
    throw new Error('To create drafts, use --apply with exactly one of --only or --all-candidates');
  }
  const root = resolve(values.dir);
  const out = join(root, 'output-dgxa');
  const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as unknown;
  const catalogue = manifest.parse(await readJson(join(root, 'catalog.json')));
  const progress = results.parse(await readJson(join(out, 'dgxa-results.json')));
  const ids = new Set(catalogue.tracks.map((t) => t.id));
  if (ids.size !== catalogue.tracks.length) throw new Error('catalogue contains duplicate IDs');
  const requested = values.only?.split(',').map((id) => id.trim());
  if (requested?.some((id) => !ids.has(id))) throw new Error('--only includes an unknown catalogue ID');
  const chosen = catalogue.tracks.filter((t) => !requested || requested.includes(t.id));

  const ctx = values.apply ? createContext(loadConfig()) : null;
  const audio = ctx?.audio ?? new AudioProcessor();
  const fingerprints = new Map<string, string>();
  let errors = 0;
  try {
    for (const entry of chosen) {
      const record = Object.hasOwn(progress.tracks, entry.id) ? progress.tracks[entry.id] : undefined;
      if (record?.status !== 'candidate' || !record.file) {
        console.log(JSON.stringify({ take: entry.id, status: 'skipped', reason: 'no candidate MP3 in the batch record' }));
        if (requested && values.apply) errors++;
        continue;
      }
      try {
        // Do not follow an imported path outside this manifest's output folder.
        if (!record.file.startsWith(`${entry.id}-`) || !/^[^/\\\u0000-\u001f]+\.mp3$/i.test(record.file)) {
          throw new Error('candidate filename must be an MP3 in output-dgxa with its take number');
        }
        const path = join(out, record.file);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.size > OFFICIAL_BGM_MAX_BYTES) throw new Error('expected a regular MP3 file no larger than 32 MiB');
        const bytes = await readFile(path);
        const input = officialBgmImportInput.parse({ ...entry.bgm, title: entry.title, sourceKey: `${catalogue.batch}-${entry.id}`,
          previewStartSeconds: entry.previewStartSeconds });
        if (ctx) {
          const imported = await importOfficialBgm(ctx, input, bytes);
          console.log(JSON.stringify({ take: entry.id, title: input.title, ...imported }));
        } else {
          const media = await inspectOfficialBgmSource(audio, bytes, input.previewStartSeconds);
          const firstTake = fingerprints.get(media.sha256);
          if (firstTake) throw new Error(`same MP3 as catalog entry ${firstTake}`);
          fingerprints.set(media.sha256, entry.id);
          console.log(JSON.stringify({ take: entry.id, title: input.title, ...media, status: 'eligible' }));
        }
      } catch (error) {
        errors++;
        console.error(JSON.stringify({ take: entry.id, status: 'error', message: error instanceof Error ? error.message : 'import failed' }));
      }
    }
  } finally {
    if (ctx) await closeDb();
  }
  return Number(errors > 0);
}

main().then((status) => { process.exitCode = status; }).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'import failed');
  process.exitCode = 1;
});
