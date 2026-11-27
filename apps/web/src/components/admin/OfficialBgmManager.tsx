import { useEffect, useRef, useState } from 'react';
import {
  OFFICIAL_BGM_ACTIONS, OFFICIAL_BGM_INTRO_MAX, OFFICIAL_BGM_LANGS, OFFICIAL_BGM_SALE_RIGHTS, OFFICIAL_BGM_TAGS_MAX,
  OFFICIAL_BGM_TRANSITIONS, type OfficialBgmSaleRights,
  type OfficialBgmAction, type OfficialBgmAdminItem, type OfficialBgmBulkResult, type OfficialBgmLang, type OfficialBgmPublicationQueue,
} from '@yuha/contracts';
import { ApiError, apiFetch } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { OFFICIAL_BGM_ADMIN, useOfficialBgmCatalog } from '../../lib/official-bgm-catalog';
import { formatTime } from '../../lib/player';
import { Badge, Loading } from '../common';
import { OfficialBgmPreview } from '../OfficialBgmPreview';
import { OfficialBgmBatchImport } from './OfficialBgmBatchImport';

/**
 * An editor's words for one track (product owner, 2026-11-27): a title and an
 * introduction in zh/ja/en, style tags, and the YUHA recommendation score. A
 * language left empty falls back to the original title and a template intro.
 */
function CatalogEditor({ track, onSaved }: { track: OfficialBgmAdminItem; onSaved: (t: OfficialBgmAdminItem) => void }) {
  const { t } = useI18n();
  const blank = { title: '', intro: '' };
  const [copy, setCopy] = useState<Record<OfficialBgmLang, { title: string; intro: string }>>(() => ({
    zh: { ...blank, ...track.copy?.zh }, ja: { ...blank, ...track.copy?.ja }, en: { ...blank, ...track.copy?.en },
  }));
  const [tags, setTags] = useState((track.tags ?? []).join(', '));
  const [rating, setRating] = useState(typeof track.rating === 'number' ? track.rating.toFixed(1) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const score = rating.trim() === '' ? null : Number(rating);
  const scoreOk = score === null || (Number.isFinite(score) && score >= 1 && score <= 5);

  async function save() {
    setSaving(true);
    setError(false);
    try {
      const updated = await apiFetch<OfficialBgmAdminItem>(`${OFFICIAL_BGM_ADMIN}/${track.id}/catalog`, {
        method: 'POST',
        body: {
          copy,
          tags: tags.split(/[,，、]/).map((x) => x.trim()).filter(Boolean).slice(0, OFFICIAL_BGM_TAGS_MAX),
          rating: score === null ? null : Math.round(score * 10) / 10,
        },
      });
      onSaved(updated);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="market-source">
      <summary>{t('market.copy.title')}</summary>
      <form className="stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {OFFICIAL_BGM_LANGS.map((lang) => (
          <fieldset key={lang} className="market-copy">
            <legend>{t(`market.copy.lang.${lang}`)}</legend>
            <label className="field">
              <span>{t('market.copy.trackTitle')}</span>
              <input type="text" maxLength={120} value={copy[lang].title} placeholder={track.title}
                onChange={(e) => setCopy({ ...copy, [lang]: { ...copy[lang], title: e.target.value } })} />
            </label>
            <label className="field">
              <span>{t('market.copy.intro')}</span>
              <textarea rows={2} maxLength={OFFICIAL_BGM_INTRO_MAX} value={copy[lang].intro} placeholder={t('market.copy.introPlaceholder')}
                onChange={(e) => setCopy({ ...copy, [lang]: { ...copy[lang], intro: e.target.value } })} />
            </label>
          </fieldset>
        ))}
        <label className="field">
          <span>{t('market.copy.tags')}</span>
          <input type="text" value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('market.copy.rating')}</span>
          <input type="number" inputMode="decimal" min={1} max={5} step={0.1} value={rating} onChange={(e) => setRating(e.target.value)} />
        </label>
        <p className="small muted">{t('market.rating.note')}</p>
        {error && <p role="alert">{t('market.admin.saveError')}</p>}
        <button type="submit" className="btn btn--primary" disabled={saving || !scoreOk}>
          {t(saving ? 'market.admin.saving' : 'market.copy.save')}
        </button>
      </form>
    </details>
  );
}

/**
 * Sale rights for one track (docs/PAYMENTS_DESIGN.md §1): reviewed on their
 * own, with the basis written down. Publishing a track never clears them.
 */
function SaleRights({ track, onSaved }: { track: OfficialBgmAdminItem; onSaved: (t: OfficialBgmAdminItem) => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<OfficialBgmSaleRights>(track.saleRights ?? 'unreviewed');
  const [basis, setBasis] = useState(track.saleRightsBasis ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const ready = status === 'unreviewed' || basis.trim().length >= 5;

  async function save() {
    setSaving(true);
    setError(false);
    try {
      onSaved(await apiFetch<OfficialBgmAdminItem>(`${OFFICIAL_BGM_ADMIN}/${track.id}/sale-rights`, {
        method: 'POST', body: { status, basis: basis.trim() },
      }));
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <details className="market-source">
      <summary>{t('market.sale.title')} · {t(`market.sale.status.${track.saleRights ?? 'unreviewed'}`)}</summary>
      <form className="stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <p className="small muted">{t('market.sale.help')}</p>
        <label className="field">
          <span>{t('market.sale.decision')}</span>
          <select value={status} disabled={saving} onChange={(e) => setStatus(e.target.value as OfficialBgmSaleRights)}>
            {OFFICIAL_BGM_SALE_RIGHTS.map((s) => <option key={s} value={s}>{t(`market.sale.status.${s}`)}</option>)}
          </select>
        </label>
        <label className="field">
          <span>{t('market.sale.basis')}</span>
          <textarea rows={2} maxLength={500} value={basis} disabled={saving || status === 'unreviewed'}
            onChange={(e) => setBasis(e.target.value)} />
        </label>
        {error && <p role="alert">{t('market.admin.saveError')}</p>}
        <button type="submit" className="btn btn--primary" disabled={saving || !ready}>
          {t(saving ? 'market.admin.saving' : 'market.copy.save')}
        </button>
      </form>
    </details>
  );
}

/**
 * "Approve and publish all" (product owner, 2026-11-27): every draft and
 * reviewed track, in the same two steps as by hand, with one reason. Tracks
 * whose preview is missing stay where they are and are listed.
 */
function PublishAll({ queue, loading, onDone }: {
  queue?: OfficialBgmPublicationQueue; loading: boolean; onDone: () => void;
}) {
  const { t } = useI18n();
  const [scope, setScope] = useState<OfficialBgmPublicationQueue>();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<OfficialBgmBulkResult>();
  const [error, setError] = useState('');
  const note = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const toolbarStatus = useRef<HTMLParagraphElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (scope) note.current?.focus(); }, [scope]);

  function close(restoreTrigger: boolean) {
    setScope(undefined);
    requestAnimationFrame(() => {
      const button = trigger.current;
      const target = restoreTrigger && button && !button.disabled ? button : feedback.current ?? toolbarStatus.current;
      target?.focus();
    });
  }

  async function run() {
    if (!scope || busy || reason.trim().length < 5) return;
    setBusy(true);
    setError('');
    try {
      setOutcome(await apiFetch<OfficialBgmBulkResult>(`${OFFICIAL_BGM_ADMIN}/publish-all`, {
        method: 'POST', body: { reason: reason.trim(), revision: scope.revision },
      }));
      close(false);
      onDone();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setError('market.publishAll.changed');
        close(false);
        onDone();
      } else {
        setError('market.admin.saveError');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="market-publish-all">
      <div className="market-admin__toolbar">
        <p className="small muted" ref={toolbarStatus} tabIndex={-1}>{queue
          ? t(queue.count ? 'market.publishAll.pending' : 'market.publishAll.none', { count: queue.count })
          : t(loading ? 'market.publishAll.loading' : 'market.publishAll.unavailable')}</p>
        {!scope && <button ref={trigger} type="button" className="btn btn--primary"
          disabled={loading || !queue?.count} onClick={() => {
            setScope(queue); setError(''); setOutcome(undefined); setReason('');
          }}>{t('market.publishAll')}</button>}
      </div>
      {scope && (
        <form className="market-admin__confirm stack" onSubmit={(event) => { event.preventDefault(); void run(); }}>
          <h3>{t('market.publishAll.scope', { count: scope.count })}</h3>
          <p className="small muted">{t('market.publishAll.help')}</p>
          <label className="field">
            <span>{t('market.admin.reason')}</span>
            <textarea ref={note} required minLength={5} maxLength={500} rows={2} value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="market-admin__actions">
            <button type="submit" className="btn btn--primary" disabled={busy || reason.trim().length < 5}>
              {t(busy ? 'market.publishAll.running' : 'market.publishAll.confirm')}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => close(true)}>{t('market.admin.cancel')}</button>
          </div>
        </form>
      )}
      {error && <p className="small market-admin__problem" role="alert" ref={feedback} tabIndex={-1}>{t(error)}</p>}
      {outcome && <div className="market-admin__bulk-result">
        <p role="status" ref={feedback} tabIndex={-1}>
          {t('market.publishAll.done', { count: outcome.published })}{' '}
          {outcome.failed.length > 0 && t('market.publishAll.failed', { count: outcome.failed.length })}
        </p>
        {outcome.failed.length > 0 && <ul className="small">
          {outcome.failed.map((item) => <li key={item.id}>
            <strong>{item.title || item.id}</strong>{' · '}{t(`market.publishAll.issue.${item.reason ?? 'save_failed'}`)}
          </li>)}
        </ul>}
      </div>}
    </div>
  );
}

function ImportedBgmDetails({ track }: { track: OfficialBgmAdminItem }) {
  const { t } = useI18n();
  const [cover, setCover] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [coverError, setCoverError] = useState(false);
  const source = track.provenance;
  if (!source) return null;

  async function loadCover() {
    setLoading(true);
    setCoverError(false);
    try {
      const result = await apiFetch<{ url: string }>(`${OFFICIAL_BGM_ADMIN}/${track.id}/cover`);
      setCover(result.url);
    } catch {
      setCoverError(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <details className="market-source">
      <summary>{t('market.source.title')}</summary>
      <dl className="small">
        <dt>{t('market.source.series')}</dt><dd>{source.series}</dd>
        <dt>{t('market.source.master')}</dt><dd>{source.masterFilename}</dd>
        <dt>{t('market.source.originalTags')}</dt><dd>{source.style} · {source.originalScenario} · {source.originalMood}</dd>
        <dt>{t('market.source.model')}</dt><dd>{source.model} · {source.modelVersion}</dd>
        <dt>{t('market.source.seed')}</dt><dd>{source.seed}</dd>
        <dt>{t('market.source.time')}</dt><dd>{source.generatedAt}</dd>
        <dt>{t('market.source.license')}</dt><dd>{t(`market.source.license.${source.licenseStatus}`)}</dd>
        <dt>{t('market.source.prompt')}</dt><dd>{source.prompt}</dd>
        {source.note && <><dt>{t('market.source.note')}</dt><dd>{source.note}</dd></>}
      </dl>
      {track.hasCover && (cover ? <img className="market-source__cover" src={cover} alt={t('market.source.cover', { title: track.title })}
        onError={() => { setCover(undefined); setCoverError(true); }} /> :
        <button type="button" className="btn" disabled={loading}
          onClick={() => void loadCover()}>{t(loading ? 'market.import.reading' : 'market.source.openCover')}</button>)}
      {coverError && <p className="small" role="alert">{t('market.source.coverError')}</p>}
    </details>
  );
}

export function OfficialBgmManager() {
  const { t } = useI18n();
  const catalog = useOfficialBgmCatalog<OfficialBgmAdminItem>(OFFICIAL_BGM_ADMIN);
  const [view, setView] = useState<'review' | 'import'>('review');
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const importHeading = useRef<HTMLHeadingElement>(null);
  const [preview, setPreview] = useState<OfficialBgmAdminItem | null>(null);
  const previewButton = useRef<HTMLButtonElement | null>(null);
  const [confirmation, setConfirmation] = useState<{ track: OfficialBgmAdminItem; action: OfficialBgmAction['action'] } | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState('');
  const [saveError, setSaveError] = useState('');
  const trackNote = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (confirmation) trackNote.current?.focus(); }, [confirmation]);

  function closeTrackForm(trackId: string) {
    setConfirmation(null);
    requestAnimationFrame(() => document.getElementById(`bgm-track-${trackId}`)?.focus());
  }

  function openPanel(panel: typeof view) {
    setView(panel);
    requestAnimationFrame(() => (panel === 'review' ? reviewHeading : importHeading).current?.focus());
  }

  async function save() {
    if (!confirmation || saving || reason.trim().length < 5) return;
    const { track, action } = confirmation;
    setSaving(true);
    setSaveError('');
    try {
      const { pendingPublication, ...updated } = await apiFetch<OfficialBgmAdminItem & { pendingPublication?: OfficialBgmPublicationQueue }>(
        `${OFFICIAL_BGM_ADMIN}/${track.id}/state`, {
        method: 'POST', body: { action, reason: reason.trim() },
      });
      catalog.replace(updated, pendingPublication);
      closeTrackForm(track.id);
      setResult(t('market.admin.saved', { title: updated.title, state: t(`market.state.${updated.state}`) }));
    } catch (error) {
      const previewMissing = error instanceof ApiError
        && (error.details as { reason?: string } | undefined)?.reason === 'preview_missing';
      setSaveError(previewMissing ? 'market.publishAll.issue.preview_missing' : 'market.admin.saveError');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="market-admin">
      <div className="market-admin__switch" role="group" aria-label={t('market.admin.tab')}>
        <button type="button" className="btn" aria-controls="market-review-panel" aria-pressed={view === 'review'}
          onClick={() => setView('review')}>{t('market.admin.review')}</button>
        <button type="button" className="btn" aria-controls="market-import-panel" aria-pressed={view === 'import'}
          onClick={() => { setPreview(null); setView('import'); }}>{t('market.import.title')}</button>
      </div>
      <section className="market-admin__panel" id="market-import-panel" hidden={view !== 'import'} aria-labelledby="market-import-title">
        <h2 id="market-import-title" ref={importHeading} tabIndex={-1}>{t('market.import.title')}</h2>
        <OfficialBgmBatchImport onImported={catalog.reload} onReview={() => openPanel('review')} />
      </section>
      <section className="market-admin__panel" id="market-review-panel" hidden={view !== 'review'} aria-labelledby="market-review-title">
        <header>
          <h2 id="market-review-title" ref={reviewHeading} tabIndex={-1}>{t('market.admin.review')}</h2>
          <p className="small muted">{t('market.admin.lede')}</p>
        </header>
        <PublishAll queue={catalog.failed ? undefined : catalog.pendingPublication} loading={catalog.pending} onDone={catalog.reload} />
        {result && <p role="status" className="market-admin__result">{result}</p>}
        {catalog.items.length === 0 && catalog.pending && <Loading />}
        {catalog.items.length === 0 && !catalog.pending && !catalog.failed &&
          <div className="market-empty">
            <p>{t('market.admin.empty')}</p>
            <button type="button" className="btn" onClick={() => openPanel('import')}>{t('market.import.title')}</button>
          </div>}
        <ul className="market-admin__list">
          {catalog.items.map((track) => (
            <li className="market-admin__track" key={track.id}>
              <div className="market-admin__info">
                <h3 id={`bgm-track-${track.id}`} tabIndex={-1}>{track.title}</h3>
                <Badge>{t(`market.state.${track.state}`)}</Badge>
                <p className="small muted">{track.sourceKey} · {formatTime(track.durationSeconds)} · {t(`bgm.genre.${track.genre}`)}</p>
                <p className="small muted">{t('market.admin.excerpt', {
                  start: formatTime(track.previewStartSeconds), length: formatTime(track.previewSeconds),
                })}</p>
                <ImportedBgmDetails track={track} />
                <SaleRights track={track} onSaved={(updated) => {
                  catalog.replace(updated);
                  setResult(t('market.sale.saved', { title: updated.title, status: t(`market.sale.status.${updated.saleRights}`) }));
                }} />
                <CatalogEditor track={track} onSaved={(updated) => {
                  catalog.replace(updated);
                  setResult(t('market.copy.saved', { title: updated.title }));
                }} />
              </div>
              <div className="market-admin__actions">
                <button type="button" className="btn" aria-pressed={preview?.id === track.id}
                  aria-label={t('market.previewTrack', { title: track.title })}
                  onClick={(event) => {
                    previewButton.current = event.currentTarget;
                    setPreview((current) => current?.id === track.id ? null : track);
                  }}>{t('market.preview')}</button>
                {OFFICIAL_BGM_ACTIONS.filter((action) => OFFICIAL_BGM_TRANSITIONS[track.state][action]).map((action) => (
                  <button type="button" className={action === 'publish' ? 'btn btn--primary' : 'btn'} key={action} disabled={saving}
                    onClick={() => {
                      setReason('');
                      setResult('');
                      setSaveError('');
                      setConfirmation({ track, action });
                    }}>{t(`market.action.${action}`)}</button>
                ))}
              </div>
              {preview?.id === track.id && <OfficialBgmPreview track={preview} endpoint={OFFICIAL_BGM_ADMIN}
                onClose={() => { setPreview(null); previewButton.current?.focus(); }} />}
              {confirmation?.track.id === track.id && (
                <form className="market-admin__confirm stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
                  <h4>{t('market.admin.confirm', { action: t(`market.action.${confirmation.action}`), title: track.title })}</h4>
                  <p className="small muted">{t(`market.admin.help.${confirmation.action}`)}</p>
                  <label className="field">
                    <span>{t('market.admin.reason')}</span>
                    <textarea ref={trackNote} required minLength={5} maxLength={500} rows={2} value={reason} disabled={saving}
                      onChange={(event) => setReason(event.target.value)} />
                  </label>
                  {saveError && <p className="market-admin__problem" role="alert">{t(saveError)}</p>}
                  <div className="market-admin__actions">
                    <button type="submit" className="btn btn--primary" disabled={saving || reason.trim().length < 5}>
                      {t(saving ? 'market.admin.saving' : 'market.admin.submit')}
                    </button>
                    <button type="button" className="btn" disabled={saving} onClick={() => closeTrackForm(track.id)}>{t('market.admin.cancel')}</button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
        {catalog.failed ? (
          <div className="market-empty">
            <p role="alert">{t('market.catalogError')}</p>
            <button type="button" className="btn" onClick={catalog.retry}>{t('market.retry')}</button>
          </div>
        ) : catalog.nextOffset !== null && (
          <button type="button" className="btn market-more" disabled={catalog.pending} onClick={catalog.loadMore}>
            {t(catalog.pending ? 'market.loadingMore' : 'market.more')}
          </button>
        )}
      </section>
    </div>
  );
}
