import { randomUUID } from 'node:crypto';
import {
  anonymiseUser,
  claimAccountDeletion,
  execute,
  failAccountDeletion,
  query,
  recordAccountDeletionOutcome,
  type AccountDeletionRow,
} from '@yuha/db';
import type { AppContext } from '../context.js';

/**
 * What an erasure did, and what it would not touch.
 *
 * Recorded on the request row because the answer the user gets is prose, and
 * prose is not an audit trail. If someone asks in a year what happened to
 * their songs, this is the record that answers.
 */
export interface DeletionOutcome {
  tracksErased: number;
  objectsRemoved: number;
  /** Tracks kept, and the reason each was kept. */
  held: Array<{ trackId: string; reason: 'rights_case_open' | 'licensed_by_others' }>;
  objectsFailed: number;
}

interface OwnedTrack {
  id: string;
  open_cases: number;
  licences: number;
}

/**
 * Erase an account, honouring the three things the product keeps.
 *
 * The endpoint has always told people what goes and what stays. Nothing ever
 * carried that out, so this is the first code that has to mean it — and
 * writing it found a promise the response does not make:
 *
 *   1. **A track under an open rights case stays.** Already the rule in
 *      `softDeleteTrack`, and already in the response's retained list.
 *   2. **Orders and payments stay** for the statutory period, which is why the
 *      user row is anonymised rather than deleted: those rows reference it, and
 *      a hard delete would either fail on the foreign key or orphan a financial
 *      record this company is required to hold.
 *   3. **A track somebody else has licensed stays.** A buyer paid for the right
 *      to download that song; erasing it on the author's request would take
 *      away something a third party owns. The response did not say this, and
 *      now does — a promise to remove "your songs" that quietly keeps some of
 *      them is the kind of thing that is only ever discovered by the person it
 *      surprises.
 *
 * Audio objects go before the rows that name them. The other order loses the
 * keys on a half-finished run and leaves files nobody can find again, which is
 * the one failure mode that cannot be repaired by running it a second time.
 */
export async function executeAccountDeletion(
  ctx: AppContext,
  deletion: AccountDeletionRow,
  /** The caller's logger. An object we could not erase has to be shouted about. */
  log?: { error: (obj: unknown, msg: string) => void },
): Promise<DeletionOutcome> {
  if (!(await claimAccountDeletion(deletion.id))) {
    throw new Error('deletion is not in the verified state, or another run claimed it');
  }

  const outcome: DeletionOutcome = { tracksErased: 0, objectsRemoved: 0, held: [], objectsFailed: 0 };

  try {
    const tracks = await query<OwnedTrack>(
      `SELECT t.id,
              (SELECT COUNT(*) FROM rights_cases rc
                WHERE rc.track_id = t.id
                  AND rc.status IN ('received','under_review','suspended')) AS open_cases,
              (SELECT COUNT(*) FROM track_licenses tl WHERE tl.track_id = t.id) AS licences
         FROM tracks t
        WHERE t.owner_id = ?`,
      [deletion.user_id],
    );

    for (const track of tracks) {
      if (Number(track.open_cases) > 0) {
        outcome.held.push({ trackId: track.id, reason: 'rights_case_open' });
        continue;
      }
      if (Number(track.licences) > 0) {
        outcome.held.push({ trackId: track.id, reason: 'licensed_by_others' });
        continue;
      }

      const assets = await query<{ id: string; storage_key: string }>(
        `SELECT id, storage_key FROM asset_versions WHERE track_id = ?`,
        [track.id],
      );
      for (const asset of assets) {
        try {
          await ctx.storage.remove('delivery', asset.storage_key);
          outcome.objectsRemoved += 1;
        } catch (err) {
          // One unreachable object must not abandon the rest of the erasure.
          // It is counted and logged, the run keeps going, and the count is on
          // the record so nobody has to take "deleted" on trust.
          outcome.objectsFailed += 1;
          log?.error({ err, key: asset.storage_key }, 'could not remove a stored object');
        }
      }
      await execute(`DELETE FROM asset_versions WHERE track_id = ?`, [track.id]);
      await execute(
        `UPDATE tracks SET deleted_at = UTC_TIMESTAMP(3), state = 'deleted',
                           lyrics = NULL, lyric_timings = NULL, updated_at = UTC_TIMESTAMP(3)
          WHERE id = ?`,
        [track.id],
      );
      outcome.tracksErased += 1;
    }

    // Raw provider output for this user's attempts. The quarantine lifecycle
    // rule expires these after 30 days anyway; a deletion should not wait for
    // the calendar.
    const attempts = await query<{ job_id: string; attempt_no: number }>(
      `SELECT a.job_id, a.attempt_no
         FROM generation_attempts a
         JOIN generation_jobs j ON j.id = a.job_id
        WHERE j.user_id = ?`,
      [deletion.user_id],
    );
    for (const a of attempts) {
      try {
        await ctx.storage.remove('quarantine', `${a.job_id}/attempt-${a.attempt_no}.audio`);
        outcome.objectsRemoved += 1;
      } catch (err) {
        outcome.objectsFailed += 1;
        log?.error({ err, jobId: a.job_id }, 'could not remove a quarantined object');
      }
    }

    await anonymiseUser({ userId: deletion.user_id, tombstone: randomUUID().slice(0, 12) });
    await recordAccountDeletionOutcome({ id: deletion.id, outcome });
    return outcome;
  } catch (err) {
    await failAccountDeletion({ id: deletion.id, failure: (err as Error).message });
    await recordAccountDeletionOutcome({ id: deletion.id, outcome });
    throw err;
  }
}
