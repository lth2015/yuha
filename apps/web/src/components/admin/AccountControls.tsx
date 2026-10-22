import { useState } from 'react';
import { apiFetch } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { Badge, ErrorNotice } from '../common';

/**
 * Suspend, reactivate and re-role one account — by the email the operator
 * searched for, on the customer record they just opened.
 *
 * The server enforces every rule (services/account-admin.ts); the buttons
 * here are disabled for the same cases only so nobody is invited to press
 * something that will be refused: your own account, another administrator's
 * suspension, a deleted account. A reason is required, as on every privileged
 * action, and lands in the audit log beside the change.
 */
type Role = 'user' | 'support' | 'admin';
const ROLES: Role[] = ['user', 'support', 'admin'];
/** Literal keys, so `check:i18n` sees each one in use. */
const ROLE_LABEL: Record<Role, string> = {
  user: 'admin.acct.role.user',
  support: 'admin.acct.role.support',
  admin: 'admin.acct.role.admin',
};

export function AccountControls(props: {
  userId: string;
  role: string;
  status: string;
  isSelf: boolean;
  isAdmin: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  const [role, setRole] = useState<Role>((ROLES as string[]).includes(props.role) ? (props.role as Role) : 'user');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  const deleted = props.status === 'deleted';
  const reasonOk = reason.trim().length >= 5;

  const act = async (path: string, body: Record<string, unknown>, doneKey: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await apiFetch<{ changed: boolean }>(`/v1/admin/users/${props.userId}/${path}`, {
        method: 'POST',
        body: { ...body, reason: reason.trim() },
      });
      await props.onChanged();
      setReason('');
      setDone(res.changed ? t(doneKey) : t('admin.acct.noChange'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const canSuspend = props.isAdmin && !props.isSelf && !deleted && props.status === 'active' && props.role !== 'admin';
  const canReactivate = props.isAdmin && !deleted && props.status === 'suspended';
  const canRole = props.isAdmin && !props.isSelf && !deleted && props.status === 'active' && role !== props.role;

  return (
    <div className="stack" style={{ gap: 'var(--s2)' }}>
      <h3 style={{ fontSize: 15, margin: 0 }}>{t('admin.acct.h3')}</h3>
      <div className="row" style={{ gap: 'var(--s2)', flexWrap: 'wrap' }}>
        <Badge tone={props.status === 'active' ? '' : 'badge--warn'}>
          {props.status === 'active'
            ? t('admin.acct.status.active')
            : props.status === 'suspended'
              ? t('admin.acct.status.suspended')
              : t('admin.acct.status.deleted')}
        </Badge>
        <Badge tone={props.role === 'user' ? '' : 'badge--accent'}>
          {t(ROLE_LABEL[(ROLES as string[]).includes(props.role) ? (props.role as Role) : 'user'])}
        </Badge>
      </div>

      {!props.isAdmin ? (
        <p className="small muted" style={{ margin: 0 }}>
          {t('admin.acct.adminOnly')}
        </p>
      ) : props.isSelf ? (
        <p className="small muted" style={{ margin: 0 }}>
          {t('admin.acct.self')}
        </p>
      ) : deleted ? (
        <p className="small muted" style={{ margin: 0 }}>
          {t('admin.acct.deleted')}
        </p>
      ) : (
        <>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('admin.sc.reason')}
            aria-label={t('admin.sc.reason')}
            style={{ maxWidth: 420 }}
          />
          <div className="row" style={{ gap: 'var(--s2)', flexWrap: 'wrap', alignItems: 'center' }}>
            {props.status === 'suspended' ? (
              <button
                type="button"
                className="btn"
                disabled={!canReactivate || !reasonOk || busy}
                onClick={() => void act('reactivate', {}, 'admin.acct.reactivated')}
              >
                {t('admin.acct.reactivate')}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--danger"
                disabled={!canSuspend || !reasonOk || busy}
                onClick={() => void act('suspend', {}, 'admin.acct.suspended')}
              >
                {t('admin.acct.suspend')}
              </button>
            )}
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              aria-label={t('admin.acct.roleLabel')}
              style={{ width: 'auto', minWidth: 140, marginLeft: 'var(--s4)' }}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(ROLE_LABEL[r])}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={!canRole || !reasonOk || busy}
              onClick={() => void act('role', { role }, 'admin.acct.roleChanged')}
            >
              {t('admin.acct.saveRole')}
            </button>
          </div>
          {props.role === 'admin' && props.status === 'active' && (
            <p className="small muted" style={{ margin: 0 }}>
              {t('admin.acct.adminTarget')}
            </p>
          )}
          <p className="small muted" style={{ margin: 0 }}>
            {t('admin.acct.effect')}
          </p>
        </>
      )}
      <ErrorNotice error={error} />
      {done && (
        <p className="small" role="status" style={{ margin: 0 }}>
          {done}
        </p>
      )}
    </div>
  );
}
