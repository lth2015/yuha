import { execute, newId, query, withTx } from '@yuha/db';
import type { QueueAdapter, QueueMessage } from './types.js';

/**
 * Database-backed local queue.
 *
 * Deliberately reproduces SQS Standard's awkward parts rather than hiding them:
 * visibility timeouts, redelivery after a crash, and no ordering guarantee. A
 * consumer written against this adapter is therefore already correct under real
 * SQS. Messages surviving `maxReceiveCount` deliveries are dead-lettered.
 */
export class LocalQueueAdapter implements QueueAdapter {
  readonly kind = 'local-mysql';
  private readonly queueName: string;
  private readonly maxReceiveCount: number;

  constructor(params: { queueName: string; maxReceiveCount?: number }) {
    this.queueName = params.queueName;
    this.maxReceiveCount = params.maxReceiveCount ?? 5;
  }

  async send(params: { body: Record<string, unknown>; delaySeconds?: number }): Promise<{ messageId: string }> {
    const id = newId();
    await execute(
      `INSERT INTO local_queue_messages (id, queue_name, body, visible_at)
       VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND))`,
      [id, this.queueName, JSON.stringify(params.body), params.delaySeconds ?? 0],
    );
    return { messageId: id };
  }

  async receive(params: {
    max: number;
    visibilityTimeoutSeconds: number;
    waitSeconds?: number;
  }): Promise<QueueMessage[]> {
    return withTx(async (tx) => {
      // Lock the candidates first: MySQL cannot UPDATE a table it selects from
      // in a subquery, and SKIP LOCKED keeps concurrent consumers disjoint.
      const candidates = await query<{ id: string }>(
        `SELECT id FROM local_queue_messages
          WHERE queue_name = ? AND dead_lettered = 0 AND visible_at <= UTC_TIMESTAMP(3)
          ORDER BY visible_at
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
        [this.queueName, params.max],
        tx,
      );
      if (!candidates.length) return [];

      const ids = candidates.map((c) => c.id);
      const placeholders = ids.map(() => '?').join(', ');
      const handle = newId();
      await execute(
        `UPDATE local_queue_messages
            SET receipt_handle = ?,
                receive_count = receive_count + 1,
                visible_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND)
          WHERE id IN (${placeholders})`,
        [handle, params.visibilityTimeoutSeconds, ...ids],
        tx,
      );

      const rows = await query<{
        id: string;
        body: Record<string, unknown>;
        receipt_handle: string;
        receive_count: number;
      }>(
        `SELECT id, body, receipt_handle, receive_count
           FROM local_queue_messages WHERE id IN (${placeholders})`,
        ids,
        tx,
      );

      // Past the redelivery limit, park the message instead of looping forever
      // (§12.3: retry cap and DLQ, never mask a persistent upstream fault).
      const live: QueueMessage[] = [];
      for (const r of rows) {
        if (r.receive_count > this.maxReceiveCount) {
          await execute(`UPDATE local_queue_messages SET dead_lettered = 1 WHERE id = ?`, [r.id], tx);
          continue;
        }
        live.push({
          messageId: r.id,
          // Each message gets its own handle so deleting one does not delete
          // its batch siblings.
          receiptHandle: `${r.receipt_handle}:${r.id}`,
          body: r.body,
          receiveCount: r.receive_count,
        });
      }
      return live;
    });
  }

  private static parseHandle(receiptHandle: string): { handle: string; id: string } {
    const idx = receiptHandle.lastIndexOf(':');
    return { handle: receiptHandle.slice(0, idx), id: receiptHandle.slice(idx + 1) };
  }

  async deleteMessage(receiptHandle: string): Promise<void> {
    const { handle, id } = LocalQueueAdapter.parseHandle(receiptHandle);
    await execute(`DELETE FROM local_queue_messages WHERE id = ? AND receipt_handle = ?`, [id, handle]);
  }

  async changeVisibility(receiptHandle: string, visibilityTimeoutSeconds: number): Promise<void> {
    const { handle, id } = LocalQueueAdapter.parseHandle(receiptHandle);
    await execute(
      `UPDATE local_queue_messages
          SET visible_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND)
        WHERE id = ? AND receipt_handle = ?`,
      [visibilityTimeoutSeconds, id, handle],
    );
  }

  async deadLetter(receiptHandle: string, _reason: string): Promise<void> {
    const { handle, id } = LocalQueueAdapter.parseHandle(receiptHandle);
    await execute(
      `UPDATE local_queue_messages SET dead_lettered = 1, visible_at = UTC_TIMESTAMP(3)
        WHERE id = ? AND receipt_handle = ?`,
      [id, handle],
    );
  }
}
