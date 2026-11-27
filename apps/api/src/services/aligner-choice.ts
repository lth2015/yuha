import { getUser } from '@yuha/db';
import type { AppContext } from '../context.js';

/**
 * The aligner to ask the DGX for, for a song owned by `ownerId` (LYRIC_ALIGNER):
 * 'qwen' or undefined (the DGX's own default). An owner that cannot be looked
 * up is not staff.
 */
export async function alignerFor(ctx: AppContext, ownerId: string): Promise<'qwen' | undefined> {
  const mode = ctx.config.LYRIC_ALIGNER;
  if (mode === 'all') return 'qwen';
  if (mode !== 'staff') return undefined;
  const role = (await getUser(ownerId).catch(() => undefined))?.role;
  return role === 'admin' || role === 'support' ? 'qwen' : undefined;
}
