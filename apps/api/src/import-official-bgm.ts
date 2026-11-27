import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  OFFICIAL_BGM_BATCH_SIZE, OFFICIAL_BGM_COVER_BYTES, OFFICIAL_BGM_DOCUMENT_BYTES, OFFICIAL_BGM_MASTER_BYTES,
  officialBgmCoverFor, officialBgmInventoryFor, officialBgmInventoryReport, parseOfficialBgmManifest, type OfficialBgmManifestIssue,
} from '@yuha/contracts';
import { closeDb } from '@yuha/db';
import { AudioProcessor } from '@yuha/providers';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import {
  importInputForBgmTrack, importOfficialBgm, inspectOfficialBgmCover, inspectOfficialBgmSource, officialBgmImportInput, type OfficialBgmImportInput,
} from './services/official-bgm-import.js';

const legacyManifest = z.object({
  batch: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,90}$/),
  tracks: z.array(z.object({
    id: z.string().regex(/^[a-z0-9]{1,16}$/),
    title: z.string(),
    bgm: z.object({ genre: z.string(), scenario: z.string(), mood: z.string() }),
    previewStartSeconds: z.number().optional(),
  })).min(1).max(OFFICIAL_BGM_BATCH_SIZE),
});
const legacyResults = z.object({ tracks: z.record(z.object({ status: z.string(), file: z.string().optional() })) });

async function localFile(path: string, maxBytes: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('expected a regular file within the size limit');
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('the file changed while reading it');
    return bytes.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function present(path: string) {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function ensureDirectory(path: string) {
  if (!(await lstat(path)).isDirectory()) throw new Error('expected a regular batch subdirectory');
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse((await localFile(path, OFFICIAL_BGM_DOCUMENT_BYTES)).toString('utf8'));
}

interface BatchSource {
  id: string;
  title: string;
  read: () => Promise<{ input: OfficialBgmImportInput; master: Buffer; cover?: Buffer; notes?: string[] } | null>;
}

async function dgxaSources(root: string, reportPath?: string): Promise<BatchSource[]> {
  const csv = (await localFile(join(root, 'manifest.csv'), OFFICIAL_BGM_DOCUMENT_BYTES)).toString('utf8');
  const rejected: OfficialBgmManifestIssue[] = [];
  const entries = parseOfficialBgmManifest(csv, basename(root), (issue) => rejected.push(issue));
  const defaultReport = join(root, 'inventory.json');
  const report = reportPath || await present(defaultReport)
    ? officialBgmInventoryReport.parse(await readJson(reportPath ?? defaultReport)) : undefined;
  if (report?.batch_problems?.length) console.log(JSON.stringify({ status: 'inventory-notes', notes: report.batch_problems }));
  const mastersDir = join(root, 'masters');
  const coversDir = join(root, 'covers');
  await ensureDirectory(mastersDir);
  const hasCovers = await present(coversDir);
  if (hasCovers) await ensureDirectory(coversDir);
  const covers = hasCovers ? await readdir(coversDir) : [];
  const sources: BatchSource[] = entries.map((entry) => ({
    id: entry.provenance.trackId, title: entry.title,
    async read() {
      if (!entry.genre || !entry.scenario || !entry.mood) {
        throw new Error('unmapped catalogue tags; choose tags in the browser or add genre, catalog_scenario and catalog_mood columns');
      }
      const record = officialBgmInventoryFor(report, entry.provenance);
      const coverFilename = officialBgmCoverFor(entry.provenance, covers);
      const provenance = { ...entry.provenance, ...(coverFilename ? { coverFilename } : {}) };
      const path = join(mastersDir, provenance.masterFilename);
      if (!await present(path)) return null;
      return {
        input: importInputForBgmTrack({ ...entry, genre: entry.genre, mood: entry.mood, scenario: entry.scenario,
          provenance, ...(record ? { inventory: record.evidence } : {}) }),
        master: await localFile(path, OFFICIAL_BGM_MASTER_BYTES),
        ...(coverFilename ? { cover: await localFile(join(coversDir, coverFilename), OFFICIAL_BGM_COVER_BYTES) } : {}),
        notes: record?.notes,
      };
    },
  }));
  for (const issue of rejected) {
    sources.push({ id: issue.id || String(issue.row), title: issue.title,
      async read() { throw new Error(`manifest row ${issue.row}: ${issue.message}`); } });
  }
  return sources;
}

async function legacySources(root: string): Promise<BatchSource[]> {
  const out = join(root, 'output-dgxa');
  await ensureDirectory(out);
  const catalogue = legacyManifest.parse(await readJson(join(root, 'catalog.json')));
  const progress = legacyResults.parse(await readJson(join(out, 'dgxa-results.json')));
  if (new Set(catalogue.tracks.map((item) => item.id)).size !== catalogue.tracks.length) {
    throw new Error('catalogue contains duplicate IDs');
  }
  return catalogue.tracks.map((entry) => ({
    id: entry.id, title: entry.title,
    async read() {
      const record = Object.hasOwn(progress.tracks, entry.id) ? progress.tracks[entry.id] : undefined;
      if (record?.status !== 'candidate' || !record.file) return null;
      if (!record.file.startsWith(`${entry.id}-`) || !/^[^/\\\u0000-\u001f]+\.mp3$/i.test(record.file)) {
        throw new Error('candidate filename must be an MP3 in output-dgxa with its take number');
      }
      return {
        input: officialBgmImportInput.parse({ ...entry.bgm, title: entry.title, sourceKey: `${catalogue.batch}-${entry.id}`,
          previewStartSeconds: entry.previewStartSeconds }),
        master: await localFile(join(out, record.file), OFFICIAL_BGM_MASTER_BYTES),
      };
    },
  }));
}

async function main() {
  const { values } = parseArgs({ options: {
    dir: { type: 'string' }, report: { type: 'string' }, only: { type: 'string' }, apply: { type: 'boolean' },
    'all-candidates': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (!values.dir || values.help) {
    console.log('pnpm marketplace:bgm --dir /absolute/batch-01 [--report /absolute/inventory.json] [--only 01,02] [--apply | --apply --all-candidates]');
    return values.help ? 0 : 1;
  }
  if (values.apply && Boolean(values.only) === Boolean(values['all-candidates'])) {
    throw new Error('To create drafts, use --apply with exactly one of --only or --all-candidates');
  }
  const root = resolve(values.dir);
  const dgxa = await present(join(root, 'manifest.csv'));
  if (!dgxa && values.report) throw new Error('--report is for DGXA manifest.csv batches');
  const sources = dgxa ? await dgxaSources(root, values.report ? resolve(values.report) : undefined) : await legacySources(root);
  const requested = values.only?.split(',').map((id) => id.trim());
  if (requested?.some((id) => !sources.some((source) => source.id === id))) throw new Error('--only includes an unknown catalogue ID');

  const ctx = values.apply ? createContext(loadConfig()) : null;
  const audio = ctx?.audio ?? new AudioProcessor();
  const fingerprints = new Map<string, string>();
  let errors = 0;
  try {
    for (const entry of sources.filter((source) => !requested || requested.includes(source.id))) {
      const label = { take: entry.id, title: entry.title };
      try {
        const files = await entry.read();
        if (!files) {
          console.log(JSON.stringify({ ...label, status: 'skipped', reason: 'candidate master is missing' }));
          if (dgxa || (requested && values.apply)) errors++;
          continue;
        }
        const { input, master, cover, notes } = files;
        if (ctx) {
          console.log(JSON.stringify({ ...label, ...await importOfficialBgm(ctx, input, master, { cover }), notes }));
        } else {
          await inspectOfficialBgmCover(input.provenance?.coverFilename, cover);
          const media = await inspectOfficialBgmSource(audio, master, input);
          const firstTake = fingerprints.get(media.sha256);
          if (firstTake) throw new Error(`same master as catalog entry ${firstTake}`);
          fingerprints.set(media.sha256, entry.id);
          console.log(JSON.stringify({ ...label, ...media, status: 'eligible', notes }));
        }
      } catch (error) {
        errors++;
        console.error(JSON.stringify({ ...label, status: 'error', message: error instanceof Error ? error.message : 'import failed' }));
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
