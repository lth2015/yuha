import { AppError, type UserRole } from '@yuha/contracts';
import { getUser, lockUser, setRole, setUserStatus, withTx, writeAuditLog } from '@yuha/db';

/**
 * Suspending, reactivating and re-roling an account, from the console.
 *
 * Each is admin-only (the route says so), takes a stated reason, and writes an
 * audit row in the same transaction as the change, so there is never a change
 * without its record or a record of a change that did not happen.
 *
 * What a suspension does, and does not, do:
 *
 *   - Every authenticated request re-reads the account and refuses anything
 *     not `active` (plugins/auth.ts), so the person is out on their next
 *     click — no session list to purge, no token to revoke.
 *   - It does NOT cancel a Stripe subscription, refund anything, or stop a
 *     generation already running. Those are money and provider decisions
 *     with their own tools; folding them into a ban would make an
 *     accidental ban expensive to undo. The console says so next to the button.
 *
 * Guards, each for a specific accident:
 *
 *   - not yourself: an admin who suspends or demotes their own account locks
 *     themselves out of the screen that would undo it;
 *   - not another admin: demote first, so taking an operator out is two
 *     deliberate steps with two audit rows, not one click;
 *   - not a deleted account: an erasure is final, and "unbanning" the
 *     anonymised row it left would only confuse the record.
 */
export interface Actor {
  id: string;
  role: string;
}

type Reasoned = { actor: Actor; userId: string; reason: string };

async function loadForChange(userId: string, tx: Parameters<typeof lockUser>[1]) {
  await lockUser(userId, tx);
  const user = await getUser(userId, tx);
  if (!user) throw new AppError('NOT_FOUND', 'no such account');
  if (user.status === 'deleted' || user.deleted_at) {
    throw new AppError('CONFLICT', 'this account has been deleted and cannot be changed');
  }
  return user;
}

export async function suspendAccount(p: Reasoned): Promise<{ status: 'suspended'; changed: boolean }> {
  if (p.userId === p.actor.id) throw new AppError('CONFLICT', 'you cannot suspend your own account');
  return withTx(async (tx) => {
    const user = await loadForChange(p.userId, tx);
    if (user.role === 'admin') {
      throw new AppError('CONFLICT', 'an administrator cannot be suspended — change their role first');
    }
    const changed = await setUserStatus({ userId: user.id, from: 'active', to: 'suspended' }, tx);
    if (changed) {
      await writeAuditLog(
        {
          actorId: p.actor.id,
          actorRole: p.actor.role,
          action: 'user.suspended',
          subjectType: 'user',
          subjectId: user.id,
          reason: p.reason,
          before: { status: user.status },
          after: { status: 'suspended' },
        },
        tx,
      );
    }
    return { status: 'suspended' as const, changed };
  });
}

export async function reactivateAccount(p: Reasoned): Promise<{ status: 'active'; changed: boolean }> {
  return withTx(async (tx) => {
    const user = await loadForChange(p.userId, tx);
    const changed = await setUserStatus({ userId: user.id, from: 'suspended', to: 'active' }, tx);
    if (changed) {
      await writeAuditLog(
        {
          actorId: p.actor.id,
          actorRole: p.actor.role,
          action: 'user.reactivated',
          subjectType: 'user',
          subjectId: user.id,
          reason: p.reason,
          before: { status: user.status },
          after: { status: 'active' },
        },
        tx,
      );
    }
    return { status: 'active' as const, changed };
  });
}

export async function changeRole(p: Reasoned & { role: UserRole }): Promise<{ role: UserRole; changed: boolean }> {
  if (p.userId === p.actor.id) throw new AppError('CONFLICT', 'you cannot change your own role');
  return withTx(async (tx) => {
    const user = await loadForChange(p.userId, tx);
    if (user.status !== 'active') {
      throw new AppError('CONFLICT', 'reactivate the account before changing its role');
    }
    if (user.role === p.role) return { role: p.role, changed: false };
    await setRole({ userId: user.id, role: p.role }, tx);
    await writeAuditLog(
      {
        actorId: p.actor.id,
        actorRole: p.actor.role,
        action: 'user.role_changed',
        subjectType: 'user',
        subjectId: user.id,
        reason: p.reason,
        before: { role: user.role },
        after: { role: p.role },
      },
      tx,
    );
    return { role: p.role, changed: true };
  });
}
