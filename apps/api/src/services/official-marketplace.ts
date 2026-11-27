import { AppError, OFFICIAL_BGM_TRANSITIONS, type OfficialBgmAction, type OfficialBgmAdminItem, type OfficialBgmItem } from '@yuha/contracts';
import { getOfficialBgm, setOfficialBgmState, withTx, writeAuditLog, type OfficialBgmRow } from '@yuha/db';
import type { AppContext } from '../context.js';

export function canBrowseOfficialBgm(mode: AppContext['config']['OFFICIAL_BGM_MARKETPLACE'], role?: string) {
  return mode === 'all' || (mode === 'staff' && (role === 'admin' || role === 'support'));
}

export function officialBgmItem(row: OfficialBgmRow): OfficialBgmItem {
  return {
    id: row.id, title: row.title, genre: row.genre, scenario: row.scenario, mood: row.mood,
    durationSeconds: row.master_ms / 1000, previewSeconds: row.preview_ms / 1000,
  };
}

export function officialBgmAdminItem(row: OfficialBgmRow): OfficialBgmAdminItem {
  return { ...officialBgmItem(row), state: row.state, sourceKey: row.source_key, previewStartSeconds: row.preview_start_ms / 1000 };
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
