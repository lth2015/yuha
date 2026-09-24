import type { FastifyInstance } from 'fastify';
import { createRightsCaseRequest } from '@yuha/contracts';
import {
  getTrack,
  insertRightsCase,
  query,
  setLicenseStatus,
  setTrackState,
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

      // A credible, track-identified claim pauses distribution while it is
      // reviewed. SEC-10 is explicit that a pause is NOT a finding of
      // infringement, which the response says in so many words.
      if (track && track.state === 'deliverable') {
        await setTrackState({
          trackId: track.id,
          state: 'suspended',
          reason: `rights_case:${created.case_number}`,
        });
        await setLicenseStatus({
          trackId: track.id,
          status: 'suspended',
          reason: `rights_case:${created.case_number}`,
        });
        await writeAuditLog({
          actorId: null,
          actorRole: 'system',
          action: 'track.suspended',
          subjectType: 'track',
          subjectId: track.id,
          reason: `rights case ${created.case_number} received`,
          after: { state: 'suspended' },
        });
      }

      return reply.status(201).send({
        caseNumber: created.case_number,
        status: created.status,
        receivedAt: created.created_at.toISOString(),
        notice:
          'お申し立てを受け付けました。1営業日以内に受領のご連絡をします。' +
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
