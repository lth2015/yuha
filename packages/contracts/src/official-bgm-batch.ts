import { z } from 'zod';
import { BGM_GENRES, BGM_MOODS, BGM_SCENARIOS } from './bgm.js';
import { officialBgmMetadata } from './official-bgm.js';

export const OFFICIAL_BGM_BATCH_SIZE = 30;
export const OFFICIAL_BGM_MASTER_BYTES = 96 * 1024 * 1024;
export const OFFICIAL_BGM_COVER_BYTES = 4 * 1024 * 1024;
export const OFFICIAL_BGM_DOCUMENT_BYTES = 512 * 1024;

const columns = ['id', 'file', 'title', 'series', 'style', 'mood', 'scenario', 'cover',
  'model', 'model_version', 'seed', 'prompt', 'generated_at', 'note'] as const;
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/i);
const batch = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,90}$/i);
const filename = z.string().max(255).regex(/^[^/\\\u0000-\u001f\u007f]+$/);
export const officialBgmCoverFilename = filename.refine((name) => /\.(?:png|jpe?g|webp)$/i.test(name));
const masterFilename = filename.refine((name) => /\.(?:mp3|wav)$/i.test(name));
const sha256 = z.string().regex(/^[0-9a-f]{64}$/i).transform((hex) => hex.toLowerCase());

export const officialBgmLicenseStatus = z.enum(['pending', 'cleared', 'restricted']);
/*
 * The generation record is kept as the sheet gives it, and a field the sheet
 * left empty stays empty: listed as missing (officialBgmMissingProvenance),
 * never made up, and never a reason to refuse the track (PRD: "缺失的元数据明确
 * 列出，不自行编造"). Only what identifies the track — its ID and its master
 * file — is required. The first production batch (2026-11-27) had all thirty
 * rows refused for empty generation fields.
 */
const text = (max: number) => z.string().max(max).default('').transform((value) => value.trim());
export const OFFICIAL_BGM_PROVENANCE_FIELDS = [
  'series', 'style', 'originalMood', 'originalScenario', 'model', 'modelVersion', 'seed', 'prompt', 'generatedAt',
] as const;
export const officialBgmProvenance = z.object({
  batch, trackId: id, masterFilename,
  series: text(120), style: text(120), originalMood: text(120), originalScenario: text(120),
  model: text(120), modelVersion: text(120), seed: text(120), prompt: text(12_000),
  generatedAt: text(80), note: z.string().max(2_000).default(''),
  licenseStatus: officialBgmLicenseStatus.default('pending'),
  coverFilename: officialBgmCoverFilename.optional(),
});
export type OfficialBgmProvenance = z.infer<typeof officialBgmProvenance>;

/** The generation-record fields the sheet left empty, in sheet order. */
export function officialBgmMissingProvenance(p: Pick<OfficialBgmProvenance, (typeof OFFICIAL_BGM_PROVENANCE_FIELDS)[number]>): string[] {
  return OFFICIAL_BGM_PROVENANCE_FIELDS.filter((field) => !p[field]?.trim());
}

const evidence = z.object({
  sha256, bytes: z.number().int().positive().optional(), durationSeconds: z.number().finite().positive().optional(),
});

export const officialBgmBatchTrack = officialBgmMetadata.extend({
  provenance: officialBgmProvenance,
  inventory: evidence.optional(),
});
export type OfficialBgmBatchTrack = z.infer<typeof officialBgmBatchTrack>;

export const officialBgmUploadFields = z.object({ track: officialBgmBatchTrack });
export type OfficialBgmUploadResult = { id: string; status: 'imported' | 'existing' };

type BatchEntry = {
  title: string;
  provenance: OfficialBgmProvenance;
  genre?: typeof BGM_GENRES[number];
  mood?: typeof BGM_MOODS[number];
  scenario?: typeof BGM_SCENARIOS[number];
};

function csvRows(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, '');
  if (text.length > OFFICIAL_BGM_DOCUMENT_BYTES) throw new Error('manifest.csv is too large');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closed = false;

  function endCell() {
    row.push(cell);
    cell = '';
    closed = false;
  }
  function endRow() {
    endCell();
    if (row.some((value) => value.trim())) rows.push(row);
    row = [];
  }

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (char === ',') {
      endCell();
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else if (char === '"' && !closed && cell === '') {
      quoted = true;
    } else if (char === '"' || (closed && char !== ' ' && char !== '\t')) {
      throw new Error('unexpected character beside a quoted CSV field');
    } else if (!closed) {
      cell += char;
    }
  }
  if (quoted) throw new Error('unclosed quoted CSV field');
  endRow();
  return rows;
}

function category<T extends string>(value: string, choices: readonly T[]): T | undefined {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized ? choices.find((key) => key.replaceAll('_', '') === normalized) : undefined;
}

export interface OfficialBgmManifestIssue {
  row: number;
  id: string;
  title: string;
  message: string;
}

/** Keep the sheet's words for provenance, and propose matches for the storefront filters. */
export function parseOfficialBgmManifest(
  csv: string, batchName: string, reject?: (issue: OfficialBgmManifestIssue) => void,
): BatchEntry[] {
  const batchId = batch.parse(batchName);
  const [headings, ...rows] = csvRows(csv);
  const header = headings?.map((name) => name.trim());
  if (!header || new Set(header).size !== header.length || columns.some((name) => !header.includes(name))) {
    throw new Error('manifest.csv is missing required columns or has duplicate headings');
  }
  if (!rows.length || rows.length > OFFICIAL_BGM_BATCH_SIZE) throw new Error('manifest.csv must contain 1–30 tracks');
  const duplicates = (field: 'id' | 'file') => {
    const keys = rows.map((record) => record[header.indexOf(field)]?.trim().toLowerCase()).filter(Boolean);
    return new Set(keys.filter((key, index) => keys.indexOf(key) !== index));
  };
  const duplicateIds = duplicates('id');
  const duplicateFiles = duplicates('file');

  return rows.flatMap((record, index) => {
    const line = index + 2;
    const row = Object.fromEntries(header.map((name, i) => [name, record[i] ?? '']));
    const trackId = row.id!.trim();
    // "masters/x.wav" and "x.wav" name the same master.
    const sourceFile = row.file!.trim().replace(/^\.?\/?masters\//i, '');
    try {
      if (record.length !== header.length) throw new Error('the number of fields differs from the header');
      if (duplicateIds.has(trackId.toLowerCase()) || duplicateFiles.has(sourceFile.toLowerCase())) {
        throw new Error('duplicate track ID or master filename');
      }
      const declaredCover = row.cover?.trim().replace(/^covers\//, '') || undefined;
      const parsed = officialBgmProvenance.safeParse({
        batch: batchId, trackId, masterFilename: sourceFile,
        series: row.series, style: row.style, originalMood: row.mood, originalScenario: row.scenario,
        model: row.model, modelVersion: row.model_version, seed: row.seed, prompt: row.prompt,
        generatedAt: row.generated_at, note: row.note, licenseStatus: row.license_status?.trim() || undefined,
        ...(declaredCover ? { coverFilename: declaredCover } : {}),
      });
      if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.path.join('.')).join(', '));
      const value = parsed.data;
      return [{
        title: officialBgmMetadata.shape.title.parse(row.title),
        provenance: value,
        genre: category(row.genre?.trim() || value.style, BGM_GENRES),
        mood: category(row.catalog_mood?.trim() || value.originalMood, BGM_MOODS),
        scenario: category(row.catalog_scenario?.trim() || value.originalScenario, BGM_SCENARIOS),
      }];
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid catalogue row';
      if (!reject) throw new Error(`manifest row ${line}: ${message}`);
      reject({ row: line, id: trackId, title: row.title?.trim() || sourceFile, message });
      return [];
    }
  });
}

export const officialBgmInventoryReport = z.object({
  batch_problems: z.array(z.string()).optional(),
  items: z.array(z.object({
    id: z.string().nullable(), file: z.string().nullable(),
    audio: z.object({ sha256, bytes: z.number().int().positive().optional(),
      duration_s: z.number().finite().positive().optional() }).optional(),
    missing: z.array(z.string()).optional(),
    problems: z.array(z.string()).optional(),
  })).max(1000),
});
export type OfficialBgmInventoryReport = z.infer<typeof officialBgmInventoryReport>;

export function officialBgmInventoryFor(report: OfficialBgmInventoryReport | undefined, track: OfficialBgmProvenance) {
  if (!report) return undefined;
  const entries = report.items.filter((item) => item.id === track.trackId && item.file === track.masterFilename);
  const match = entries.length === 1 ? entries[0] : undefined;
  if (!match?.audio) throw new Error(`no matching audio record in inventory for ${track.trackId}`);
  return {
    evidence: { sha256: match.audio.sha256, bytes: match.audio.bytes, durationSeconds: match.audio.duration_s },
    notes: [...(match.missing ?? []), ...(match.problems ?? [])],
  };
}

export function officialBgmSourceKey(track: Pick<OfficialBgmProvenance, 'batch' | 'trackId'>): string {
  return `${track.batch.length}-${track.batch}-${track.trackId}`.toLowerCase();
}

export function officialBgmCoverFor(track: OfficialBgmProvenance, covers: readonly string[]): string | undefined {
  if (track.coverFilename) return track.coverFilename;
  const matches = covers.filter((name) => officialBgmCoverFilename.safeParse(name).success && name.replace(/\.[^.]+$/, '') === track.trackId);
  if (matches.length > 1) throw new Error(`multiple covers for ${track.trackId}; select one in manifest.csv`);
  return matches[0];
}
