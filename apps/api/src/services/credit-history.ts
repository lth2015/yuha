import type { CreditHistoryItem } from '@yuha/contracts';
import { creditOutcomes, query } from '@yuha/db';

const DAYS = 180;
const LIMIT = 100;

/**
 * The owner's credit history, one line per thing that happened
 * (docs/FAILURE_COMPENSATION_SPEC.md).
 *
 * Read from `ledger_entries`, which is the books, and assembled here rather
 * than shown raw: a generation takes two or three entries (reserve, then
 * consume or release, and a reissue when its batch expired mid-flight) and
 * a person asked "did that song cost me a credit?" wants one line with one
 * answer. That answer comes from `creditOutcomes` over the job's whole
 * ledger, not from the entries inside the window, so a job reserved just
 * before the window opened still reads correctly.
 *
 * The reissue for an expired batch is folded into its generation's line
 * (`compensated`), not listed again as a grant, or one song would look
 * compensated twice. The reason a staff member typed is never returned.
 */
export async function creditHistory(userId: string): Promise<CreditHistoryItem[]> {
  const entries = await query<{
    entry_type: string;
    units: number;
    job_id: string | null;
    reason: string;
    created_at: Date;
    batch_id: string | null;
    source: string | null;
    source_ref: string | null;
    product_key: string | null;
  }>(
    `SELECT l.entry_type, l.units, l.job_id, l.reason, l.created_at, l.batch_id,
            b.source, b.source_ref, b.product_key
       FROM ledger_entries l
       LEFT JOIN entitlement_batches b ON b.id = l.batch_id
      WHERE l.user_id = ? AND l.created_at >= UTC_TIMESTAMP(3) - INTERVAL ? DAY
        AND l.entry_type IN ('grant','reserve','consume','release','revoke')
      ORDER BY l.created_at DESC
      LIMIT 1000`,
    [userId, DAYS],
  );

  // A generation's line sits at its earliest entry in the window.
  const jobFirstSeen = new Map<string, Date>();
  const compensations: typeof entries = [];
  const items: CreditHistoryItem[] = [];
  for (const e of entries) {
    if (e.job_id && ['reserve', 'consume', 'release'].includes(e.entry_type)) {
      const seen = jobFirstSeen.get(e.job_id);
      if (!seen || e.created_at < seen) jobFirstSeen.set(e.job_id, e.created_at);
    } else if (e.entry_type === 'grant' && e.source === 'compensation') {
      if (!e.reason.startsWith('expired_batch_compensation')) compensations.push(e);
    } else if (e.entry_type === 'grant') {
      items.push({ kind: 'grant', at: e.created_at.toISOString(), source: e.source ?? 'manual_adjustment', productKey: e.product_key, units: e.units });
    } else if (e.entry_type === 'revoke') {
      items.push({ kind: 'revoke', at: e.created_at.toISOString(), units: -e.units });
    }
  }

  const compensatedJobs = compensations
    .map((c) => (c.source_ref?.startsWith('job:') ? c.source_ref.slice(4) : null))
    .filter((id): id is string => !!id);
  const jobIds = [...new Set([...jobFirstSeen.keys(), ...compensatedJobs])];
  const [outcomes, jobs, reports] = await Promise.all([
    creditOutcomes([...jobFirstSeen.keys()]),
    jobIds.length
      ? query<{ id: string; track_id: string | null; input: unknown; title: string | null; deleted_at: Date | null }>(
          `SELECT j.id, j.track_id, j.input, t.title, t.deleted_at
             FROM generation_jobs j LEFT JOIN tracks t ON t.id = j.track_id
            WHERE j.user_id = ? AND j.id IN (${jobIds.map(() => '?').join(',')})`,
          [userId, ...jobIds],
        )
      : Promise.resolve([]),
    compensations.length
      ? query<{ compensation_batch_id: string; report_number: string }>(
          `SELECT compensation_batch_id, report_number FROM issue_reports
            WHERE user_id = ? AND compensation_batch_id IN (${compensations.map(() => '?').join(',')})`,
          [userId, ...compensations.map((c) => c.batch_id)],
        )
      : Promise.resolve([]),
  ]);

  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const songOf = (jobId: string | null) => {
    const job = jobId ? jobById.get(jobId) : undefined;
    if (!job) return { trackId: null, title: null };
    const input = (typeof job.input === 'string' ? JSON.parse(job.input) : job.input) as { title?: string | null; prompt?: string };
    const live = job.track_id && !job.deleted_at ? job.track_id : null;
    const title = job.title ?? input.title ?? (input.prompt ? [...input.prompt].slice(0, 60).join('') : null);
    return { trackId: live, title: title || null };
  };

  for (const [jobId, at] of jobFirstSeen) {
    const credit = outcomes.get(jobId) ?? 'none';
    items.push({
      kind: 'generation',
      at: at.toISOString(),
      jobId,
      ...songOf(jobId),
      credit,
      units: credit === 'spent' || credit === 'held' ? -1 : 0,
    });
  }
  const reportByBatch = new Map(reports.map((r) => [r.compensation_batch_id, r.report_number]));
  for (const c of compensations) {
    const jobId = c.source_ref?.startsWith('job:') ? c.source_ref.slice(4) : null;
    items.push({
      kind: 'compensation',
      at: c.created_at.toISOString(),
      units: c.units,
      jobId,
      ...songOf(jobId),
      reportNumber: (c.batch_id && reportByBatch.get(c.batch_id)) || null,
    });
  }

  return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, LIMIT);
}
