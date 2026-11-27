import { query } from './pool.js';

/**
 * The BGM listening review's sample (docs/quality/BGM_REVIEW.md): BGM made by
 * staff, with the choices a reviewer sees and, apart from them, what the DGX
 * measured on the render (B2; null before the DGX reports it). A customer's
 * BGM is their own and is never in the review. Read-only.
 */
export interface BgmReviewItem {
  trackId: string;
  choice: { scenario: unknown; genre: unknown; mood: unknown; durationSeconds: unknown; tempo: unknown };
  quality: Record<string, unknown> | null;
}

export async function bgmReviewSet(): Promise<BgmReviewItem[]> {
  const rows = await query<{ id: string; bgm: unknown }>(
    `SELECT t.id, t.bgm
       FROM tracks t JOIN users u ON u.id = t.owner_id
      WHERE u.role IN ('admin', 'support') AND t.kind = 'bgm' AND t.deleted_at IS NULL
      ORDER BY t.created_at, t.id`,
    [],
  );
  return rows.map((r) => {
    const b = ((typeof r.bgm === 'string' ? JSON.parse(r.bgm) : r.bgm) ?? {}) as Record<string, unknown>;
    const q = b['quality'];
    return {
      trackId: r.id,
      choice: { scenario: b['scenario'], genre: b['genre'], mood: b['mood'], durationSeconds: b['durationSeconds'], tempo: b['tempo'] },
      quality: q && typeof q === 'object' ? (q as Record<string, unknown>) : null,
    };
  });
}
