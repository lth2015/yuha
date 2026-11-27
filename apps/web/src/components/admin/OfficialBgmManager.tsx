import { useRef, useState } from 'react';
import { OFFICIAL_BGM_ACTIONS, OFFICIAL_BGM_TRANSITIONS, type OfficialBgmAction, type OfficialBgmAdminItem } from '@yuha/contracts';
import { apiFetch } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { OFFICIAL_BGM_ADMIN, useOfficialBgmCatalog } from '../../lib/official-bgm-catalog';
import { formatTime } from '../../lib/player';
import { Badge, Loading } from '../common';
import { OfficialBgmPreview } from '../OfficialBgmPreview';
import { OfficialBgmBatchImport } from './OfficialBgmBatchImport';

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
  const [preview, setPreview] = useState<OfficialBgmAdminItem | null>(null);
  const previewButton = useRef<HTMLButtonElement | null>(null);
  const [confirmation, setConfirmation] = useState<{ track: OfficialBgmAdminItem; action: OfficialBgmAction['action'] } | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState('');
  const [saveError, setSaveError] = useState(false);

  async function save() {
    if (!confirmation || saving || reason.trim().length < 5) return;
    const { track, action } = confirmation;
    setSaving(true);
    setSaveError(false);
    try {
      const updated = await apiFetch<OfficialBgmAdminItem>(`${OFFICIAL_BGM_ADMIN}/${track.id}/state`, {
        method: 'POST', body: { action, reason: reason.trim() },
      });
      catalog.replace(updated);
      setConfirmation(null);
      setResult(t('market.admin.saved', { title: updated.title, state: t(`market.state.${updated.state}`) }));
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="market-admin stack" aria-labelledby="market-admin-title">
      <header>
        <h2 id="market-admin-title">{t('market.catalog')}</h2>
        <p className="muted">{t('market.admin.lede')}</p>
      </header>
      <OfficialBgmBatchImport onImported={catalog.reload} />
      {preview && <OfficialBgmPreview key={preview.id} track={preview} endpoint={OFFICIAL_BGM_ADMIN}
        onClose={() => { setPreview(null); previewButton.current?.focus(); }} />}
      {result && <p role="status" className="market-admin__result">{result}</p>}
      {catalog.items.length === 0 && catalog.pending && <Loading />}
      {catalog.items.length === 0 && !catalog.pending && !catalog.failed &&
        <p role="status" className="market-empty">{t('market.admin.empty')}</p>}
      <ul className="market-admin__list">
        {catalog.items.map((track) => (
          <li className="market-admin__track" key={track.id}>
            <div className="market-admin__info">
              <h3>{track.title}</h3>
              <Badge>{t(`market.state.${track.state}`)}</Badge>
              <p className="small muted">{track.sourceKey} · {formatTime(track.durationSeconds)} · {t(`bgm.genre.${track.genre}`)}</p>
              <p className="small muted">{t('market.admin.excerpt', {
                start: formatTime(track.previewStartSeconds), length: formatTime(track.previewSeconds),
              })}</p>
              <ImportedBgmDetails track={track} />
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
                    setSaveError(false);
                    setConfirmation({ track, action });
                  }}>{t(`market.action.${action}`)}</button>
              ))}
            </div>
            {confirmation?.track.id === track.id && (
              <form className="market-admin__confirm stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
                <h4>{t('market.admin.confirm', { action: t(`market.action.${confirmation.action}`), title: track.title })}</h4>
                <p className="small muted">{t(`market.admin.help.${confirmation.action}`)}</p>
                <label className="field">
                  <span>{t('market.admin.reason')}</span>
                  <textarea required minLength={5} maxLength={500} rows={2} value={reason} disabled={saving}
                    onChange={(event) => setReason(event.target.value)} />
                </label>
                {saveError && <p role="alert">{t('market.admin.saveError')}</p>}
                <div className="market-admin__actions">
                  <button type="submit" className="btn btn--primary" disabled={saving || reason.trim().length < 5}>
                    {t(saving ? 'market.admin.saving' : 'market.admin.submit')}
                  </button>
                  <button type="button" className="btn" disabled={saving} onClick={() => setConfirmation(null)}>{t('market.close')}</button>
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
  );
}
