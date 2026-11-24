import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TRIAL_CLAIMED_EVENT, claimPendingTrial, declinePendingTrial, hasPendingTrial } from '../lib/guest';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';

/**
 * A song made on this browser before signing in, offered to the account that
 * is signed in now (docs/legal/PRIVACY_CHANGES_2026-11.md, "认领流程").
 *
 * It used to be taken without asking, on every sign-in. A browser can be
 * shared: whoever signs in next on it is not necessarily whoever made the
 * song, and the song (and what was written to make it) would have joined
 * their account. So it is asked, and only after this account has confirmed
 * its own age and terms — the guest's confirmation is the guest's, not the
 * account's.
 */
export function TrialClaimAsk() {
  const { t } = useI18n();
  const { me, refreshMe, refreshEntitlements } = useSession();
  const [state, setState] = useState<'ask' | 'adding' | 'done' | 'gone' | 'closed' | 'confirmNo'>('ask');

  if (state === 'closed' || !me || me.role === 'guest' || !me.ageConfirmed) return null;
  // Read each render, not once: the trial is usually started on this very page load, after mount.
  if (state === 'ask' && !hasPendingTrial()) return null;

  const add = async () => {
    setState('adding');
    const claimed = await claimPendingTrial();
    if (claimed) {
      await Promise.all([refreshMe(), refreshEntitlements()]);
      // The song page it may be sitting on was "not found" a moment ago.
      window.dispatchEvent(new Event(TRIAL_CLAIMED_EVENT));
      setState('done');
    } else {
      // Spent either way (lib/guest.ts): expired, taken by another account, or never valid.
      setState(hasPendingTrial() ? 'ask' : 'gone');
    }
  };

  return (
    <section className="trial-claim" aria-labelledby="trial-claim-title" aria-live="polite">
      {state === 'done' ? (
        <p className="trial-claim__body" id="trial-claim-title">
          {t('trial.claim.done')}{' '}
          <Link to="/library" onClick={() => setState('closed')}>
            {t('trial.claim.open')}
          </Link>
        </p>
      ) : state === 'gone' ? (
        <p className="trial-claim__body" id="trial-claim-title">
          {t('trial.claim.gone')}{' '}
          <button type="button" className="text-action" onClick={() => setState('closed')}>
            {t('photo.close')}
          </button>
        </p>
      ) : (
        <>
          <h2 id="trial-claim-title">{t('trial.claim.title')}</h2>
          <p className="trial-claim__body">{t('trial.claim.body')}</p>
          <div className="trial-claim__actions">
            <button
              type="button"
              className="btn btn--primary btn--sm"
              disabled={state === 'adding'}
              aria-busy={state === 'adding'}
              onClick={() => void add()}
            >
              {state === 'adding' ? t('trial.claim.adding') : t('trial.claim.yes')}
            </button>
            {state === 'confirmNo' ? (
              <>
                <span className="trial-claim__warn">{t('trial.claim.noConfirm')}</span>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    declinePendingTrial();
                    setState('closed');
                  }}
                >
                  {t('trial.claim.noSure')}
                </button>
              </>
            ) : (
              <button type="button" className="btn btn--sm" disabled={state === 'adding'} onClick={() => setState('confirmNo')}>
                {t('trial.claim.no')}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
