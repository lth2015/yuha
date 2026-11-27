import {
  AppError, OFFICIAL_BGM_TRANSITIONS, type OfficialBgmAction, type OfficialBgmAdminItem, type OfficialBgmCatalogEdit,
  type OfficialBgmItem,
} from '@yuha/contracts';
import {
  getOfficialBgm, setOfficialBgmCatalog, setOfficialBgmState, unpublishedOfficialBgmIds, withTx, writeAuditLog,
  type OfficialBgmRow,
} from '@yuha/db';
import type { AppContext } from '../context.js';

export function canBrowseOfficialBgm(mode: AppContext['config']['OFFICIAL_BGM_MARKETPLACE'], role?: string) {
  return mode === 'all' || (mode === 'staff' && (role === 'admin' || role === 'support'));
}

export function officialBgmItem(row: OfficialBgmRow): OfficialBgmItem {
  return {
    id: row.id, title: row.title, genre: row.genre, scenario: row.scenario, mood: row.mood,
    durationSeconds: row.master_ms / 1000, previewSeconds: row.preview_ms / 1000,
    copy: row.copy ?? {}, tags: row.tags ?? [], rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
  };
}

export function officialBgmAdminItem(row: OfficialBgmRow): OfficialBgmAdminItem {
  const provenance = row.provenance ? { ...row.provenance } : null;
  if (provenance) delete provenance.coverSha256;
  return { ...officialBgmItem(row), state: row.state, sourceKey: row.source_key, previewStartSeconds: row.preview_start_ms / 1000,
    masterFormat: row.master_format, provenance, hasCover: Boolean(row.cover_key) };
}

export async function officialBgmPreview(ctx: AppContext, id: string, admin: boolean) {
  // Allow simultaneous listeners. Archive takes the exclusive lock, so it
  // cannot overtake a preview issuance or leave a gap for a newer signer.
  return withTx(async (tx) => {
    const row = await getOfficialBgm(id, tx, 'share');
    if (!row || (!admin && row.state !== 'published')) throw new AppError('NOT_FOUND', 'BGM preview not found');
    const signed = await ctx.storage.signedUrl({ zone: 'delivery', key: row.preview_key, ttlSeconds: 300 });
    return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
  });
}

export async function officialBgmCover(ctx: AppContext, id: string) {
  const key = await withTx(async (tx) => (await getOfficialBgm(id, tx, 'share'))?.cover_key);
  if (!key) throw new AppError('NOT_FOUND', 'BGM cover not found');
  const signed = await ctx.storage.signedUrl({ zone: 'delivery', key, ttlSeconds: 300 });
  return { url: signed.url };
}

export async function changeOfficialBgm(ctx: AppContext, id: string, actorId: string, change: OfficialBgmAction) {
  return withTx(async (tx) => {
    const row = await getOfficialBgm(id, tx, 'update');
    if (!row) throw new AppError('NOT_FOUND', 'BGM item not found');
    const to = OFFICIAL_BGM_TRANSITIONS[row.state][change.action];
    if (!to) throw new AppError('CONFLICT', 'this BGM has changed or cannot take that action');
    if (to === 'published') {
      const audio = await ctx.storage.get('delivery', row.preview_key).catch(() => null);
      if (!audio?.length) throw new AppError('CONFLICT', 'the BGM preview is unavailable');
    }
    await setOfficialBgmState(id, to, tx);
    await writeAuditLog({
      actorId, actorRole: 'admin', subjectType: 'official_bgm', subjectId: id,
      action: `official_bgm.${change.action}`, reason: change.reason,
      before: { state: row.state }, after: { state: to },
    }, tx);
    return officialBgmAdminItem({ ...row, state: to });
  });
}

/** An editor's three-language words, tags and score for one track, recorded in the audit log. */
export async function editOfficialBgmCatalog(id: string, actorId: string, edit: OfficialBgmCatalogEdit) {
  return withTx(async (tx) => {
    const row = await getOfficialBgm(id, tx, 'update');
    if (!row) throw new AppError('NOT_FOUND', 'BGM item not found');
    // A language with neither a title nor an intro is not stored: it falls back.
    const copy = Object.fromEntries(Object.entries(edit.copy).filter(([, v]) => v && (v.title || v.intro)));
    const rating = edit.rating === null ? null : Math.round(edit.rating * 10) / 10;
    await setOfficialBgmCatalog(id, { copy, tags: edit.tags, rating }, tx);
    await writeAuditLog({
      actorId, actorRole: 'admin', subjectType: 'official_bgm', subjectId: id, action: 'official_bgm.catalog',
      reason: 'Catalogue words, tags or score edited',
      before: { copy: row.copy, tags: row.tags, rating: row.rating === null ? null : Number(row.rating) },
      after: { copy, tags: edit.tags, rating },
    }, tx);
    return officialBgmAdminItem({ ...row, copy, tags: edit.tags, rating });
  });
}

/**
 * "Approve and publish all" (product owner, 2026-11-27): every draft or
 * reviewed track goes through the same two steps as by hand — review, then
 * publish — each in its own transaction with its own audit row and the one
 * reason given. A track whose preview is missing is left where it is and
 * reported, never published without one.
 */
export async function publishAllOfficialBgm(ctx: AppContext, actorId: string, reason: string) {
  const published: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of await unpublishedOfficialBgmIds()) {
    try {
      const now = await withTx(async (tx) => (await getOfficialBgm(id, tx, 'share'))?.state);
      if (now === 'draft') await changeOfficialBgm(ctx, id, actorId, { action: 'review', reason });
      await changeOfficialBgm(ctx, id, actorId, { action: 'publish', reason });
      published.push(id);
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : 'failed' });
    }
  }
  return { published: published.length, failed };
}
