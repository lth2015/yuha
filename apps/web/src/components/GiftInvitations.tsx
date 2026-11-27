import { useEffect, useState } from 'react';
import { GIFT_MESSAGE_MAX, GIFT_NAME_MAX, GIFT_THEMES } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { copyText } from '../lib/share';
import { giftEvent } from '../lib/gift';
import { greetingCardFile } from '../lib/share-art';
import { ErrorNotice } from './common';

interface Invitation {
  id: string;
  recipientName: string;
  senderName: string;
  message: string;
  theme: (typeof GIFT_THEMES)[number];
  status: 'active' | 'revoked';
  createdAt: string;
}

/**
 * "Make a music invitation" on the owner's song page (docs/GIFT_INVITATION_PLAN.md).
 *
 * Who it is for, a letter of up to 300 characters, a theme and a signature;
 * a preview; then a link shown once, to copy or hand to the system share
 * sheet. Below, the song's invitations, each revocable on its own. The card
 * says plainly that anyone holding the link can open it.
 */
export function GiftInvitations({ trackId, title, coverSeed, styles }: { trackId: string; title: string; coverSeed: number; styles: string[] }) {
  const { t, lang } = useI18n();
  const [carding, setCarding] = useState(false);
  const [items, setItems] = useState<Invitation[]>([]);
  const [form, setForm] = useState({ recipientName: '', senderName: '', message: '', theme: 'warm' as Invitation['theme'] });
  const [made, setMade] = useState<{ url: string; token: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = () =>
    apiFetch<{ items: Invitation[] }>(`/v1/tracks/${trackId}/gifts`).then((r) => setItems(r.items), () => undefined);
  useEffect(() => {
    void load();
  }, [trackId]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<Invitation & { url: string }>(`/v1/tracks/${trackId}/gifts`, { method: 'POST', body: form });
      setMade({ url: res.url, token: res.url.split('/gift/')[1] ?? '' });
      setCopied(false);
      void load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    if (!window.confirm(t('giftInvite.revoke.confirm'))) return;
    await apiFetch(`/v1/gifts/${id}/revoke`, { method: 'POST' }).catch(setError);
    void load();
  };
  /**
   * The greeting card (user feedback, 2026-11-27): the invitation as an image
   * with a QR code to its link, to print or post. Handed to the share sheet
   * where files can be shared, else saved. Only while the link is on screen:
   * the link is shown once and never stored, so neither is the card.
   */
  const saveCard = async () => {
    if (!made) return;
    setCarding(true);
    try {
      const file = await greetingCardFile({ title, coverSeed, styles }, made.url, {
        to: t('giftCard.to', { name: form.recipientName.trim() }),
        from: form.senderName.trim() ? t('giftCard.from', { name: form.senderName.trim() }) : '',
        message: form.message.trim(),
        scan: t('giftCard.scan'),
        site: 'yuha.studio',
        lang,
      });
      giftEvent(made.token, 'share');
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title }).catch(() => undefined);
      } else {
        const href = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = href;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(href);
      }
    } catch (err) {
      setError(err);
    } finally {
      setCarding(false);
    }
  };
  const share = async () => {
    if (!made) return;
    giftEvent(made.token, 'share');
    if (navigator.share) {
      await navigator.share({ title, text: t('giftInvite.shareText', { name: form.recipientName }), url: made.url }).catch(() => undefined);
    } else {
      setCopied(await copyText(made.url));
    }
  };

  const left = GIFT_MESSAGE_MAX - [...form.message].length;
  return (
    <section className="panel gift-make" aria-labelledby="gift-make-heading">
      <h2 id="gift-make-heading">{t('giftInvite.title')}</h2>
      <p className="small muted">{t('giftInvite.lede')}</p>
      <label htmlFor="gift-to">{t('giftInvite.to')}</label>
      <input id="gift-to" type="text" maxLength={GIFT_NAME_MAX} value={form.recipientName} placeholder={t('giftInvite.to.placeholder')}
        onChange={(e) => setForm({ ...form, recipientName: e.target.value })} />
      <label htmlFor="gift-message">{t('giftInvite.message')}</label>
      <textarea id="gift-message" rows={4} maxLength={GIFT_MESSAGE_MAX} value={form.message}
        onChange={(e) => setForm({ ...form, message: e.target.value })} />
      <p className="small muted num" aria-live="polite">{t('giftInvite.left', { n: Math.max(0, left) })}</p>
      <label htmlFor="gift-from">{t('giftInvite.from')}</label>
      <input id="gift-from" type="text" maxLength={GIFT_NAME_MAX} value={form.senderName}
        onChange={(e) => setForm({ ...form, senderName: e.target.value })} />
      <span className="studio__dial-label" id="gift-theme">{t('giftInvite.theme')}</span>
      <div className="chips" role="group" aria-labelledby="gift-theme">
        {GIFT_THEMES.map((th) => (
          <button key={th} type="button" className={`chip chip--btn${form.theme === th ? ' is-on' : ''}`} aria-pressed={form.theme === th} onClick={() => setForm({ ...form, theme: th })}>
            {t(`giftInvite.theme.${th}`)}
          </button>
        ))}
      </div>

      {form.recipientName.trim() && (
        <div className={`gift-preview gift--${form.theme}`} aria-label={t('giftInvite.preview')}>
          <p className="gift__eyebrow">{t('gift.opening')}</p>
          <p className="gift__to">{form.recipientName}</p>
          <p className="gift__title">{title}</p>
          {form.message.trim() && <p className="gift-preview__letter">{form.message}</p>}
          {form.senderName.trim() && <p className="gift__from">{t('gift.from', { name: form.senderName })}</p>}
        </div>
      )}

      <button type="button" className="btn btn--primary" disabled={busy || !form.recipientName.trim()} onClick={() => void create()}>
        {busy ? t('giftInvite.making') : t('giftInvite.make')}
      </button>
      <p className="small muted">{t('giftInvite.reach')}</p>
      {error ? <ErrorNotice error={error} /> : null}

      {made && (
        <div className="gift-made" role="status">
          <p className="small">{t('giftInvite.made')}</p>
          <input type="text" readOnly value={made.url} aria-label={t('giftInvite.link')} onFocus={(e) => e.currentTarget.select()} />
          <div className="gift-made__actions">
            <button type="button" className="btn btn--primary" onClick={() => void share()}>{t('giftInvite.share')}</button>
            <button type="button" className="btn" onClick={async () => { giftEvent(made.token, 'share'); setCopied(await copyText(made.url)); }}>
              {copied ? t('giftInvite.copied') : t('giftInvite.copy')}
            </button>
            <button type="button" className="btn" disabled={carding} onClick={() => void saveCard()}>
              {carding ? t('giftCard.making') : t('giftCard.save')}
            </button>
          </div>
          <p className="small muted">{t('giftCard.hint')}</p>
          <p className="small muted">{t('giftInvite.once')}</p>
        </div>
      )}

      {items.length > 0 && (
        <div className="gift-list">
          <h3 className="small">{t('giftInvite.list')}</h3>
          <ul>
            {items.map((g) => (
              <li key={g.id} className={`gift-list__item${g.status === 'revoked' ? ' is-revoked' : ''}`}>
                <span>{g.recipientName || t('giftInvite.removed')}</span>
                <span className="small muted">{new Date(g.createdAt).toLocaleDateString()}</span>
                {g.status === 'active' ? (
                  <button type="button" className="text-action" onClick={() => void revoke(g.id)}>{t('giftInvite.revoke')}</button>
                ) : (
                  <span className="small muted">{t('giftInvite.revoked')}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
