import type { FastifyInstance } from 'fastify';
import { createRightsCaseRequest } from '@yuha/contracts';
import {
  getTrack,
  insertRightsCase,
  query,
  writeAuditLog,
} from '@yuha/db';
import type { AppContext } from '../context.js';

function caseNumber(): string {
  const d = new Date();
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  return `RC-${stamp}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

export default async function rightsRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;

  /**
   * POST /v1/rights-cases
   *
   * SEC-10: deliberately unauthenticated and free. A rights holder must never
   * be required to create an account or pay in order to file a complaint. Rate
   * limiting is the only gate.
   */
  app.post(
    '/v1/rights-cases',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '1 hour' },
      },
    },
    async (req, reply) => {
      const body = createRightsCaseRequest.parse(req.body);

      const track = body.trackId ? await getTrack(body.trackId) : undefined;
      const created = await insertRightsCase({
        caseNumber: caseNumber(),
        trackId: track?.id ?? null,
        audioSha256: body.audioSha256 ?? null,
        reporterName: body.reporterName,
        reporterEmail: body.reporterEmail,
        claimType: body.claimType,
        description: body.description,
        evidence: body.evidenceUrls,
      });

      /*
       * Received, not acted on. Every claim naming a deliverable song used to
       * pause it on the spot: anyone holding a share link could take a
       * creator's song and its buyers' licences offline with one anonymous,
       * evidence-free request (security review YSEC03). Filing stays free and
       * needs no account; pausing is now a decision — an admin marking the
       * case under review (routes/admin.ts) — which is what the public page
       * already promised: paused "if there are reasonable grounds".
       */
      await writeAuditLog({
        actorId: null,
        actorRole: 'system',
        action: 'rights_case.received',
        subjectType: 'rights_case',
        subjectId: created.id,
        reason: `rights case ${created.case_number} received`,
        after: { trackId: track?.id ?? null },
      });

      return reply.status(201).send({
        caseNumber: created.case_number,
        status: created.status,
        receivedAt: created.created_at.toISOString(),
        notice:
          'お申し立てを受け付けました。1営業日以内に受領のご連絡をします。' +
          '相当の理由があると判断した場合は、調査の間、該当楽曲の配信を一時停止します。' +
          '調査中の一時停止は侵害の認定を意味しません。' +
          'すでに利用者の端末や外部プラットフォームに保存されたファイルを技術的に回収することはできません。',
      });
    },
  );

  /** Status lookup by case number, so a reporter can follow up without an account. */
  app.get('/v1/rights-cases/:caseNumber', async (req) => {
    const { caseNumber: num } = req.params as { caseNumber: string };
    const rows = await query<{ case_number: string; status: string; created_at: Date; updated_at: Date }>(
      `SELECT case_number, status, created_at, updated_at FROM rights_cases WHERE case_number = ?`,
      [num],
    );
    const row = rows[0];
    if (!row) return { found: false };
    // Deliberately minimal: no reporter details, no track owner, no evidence.
    return {
      found: true,
      caseNumber: row.case_number,
      status: row.status,
      receivedAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });

  void ctx;
}
