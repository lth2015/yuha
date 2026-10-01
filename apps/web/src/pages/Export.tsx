import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ExportView, LicenseSnapshotView } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatJst, useSession } from '../lib/session';
import { AudioPlayer, Badge, ErrorNotice, Loading } from '../components/common';

interface TrackDetail {
  trackId: string;
  title: string;
  state: string;
  durationSeconds: number;
  previewUrl: string | null;
  exports: Array<{
    exportId: string;
    format: string;
    clipStartSeconds: number;
    clipDurationSeconds: number;
    fadeOut: boolean;
    byteSize: number;
    sha256: string;
    createdAt: string;
  }>;
}

/**
 * UI-06 / UI-07 / UI-09: trim, export, download and the usage-terms record.
 *
 * Trimming and re-downloading never consume a generation credit, the master is
 * never overwritten, and the licence panel is labelled a usage-terms record —
 * not a copyright certificate.
 */
export default function Export() {
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();
  const { runtime } = useSession();

  const [track, setTrack] = useState<TrackDetail | null>(null);
  const [licence, setLicence] = useState<LicenseSnapshotView | null>(null);
  const [clipStart, setClipStart] = useState(0);
  const [clipDuration, setClipDuration] = useState<15 | 30>(15);
  const [fadeOut, setFadeOut] = useState(true);
  const [format, setFormat] = useState<'mp3' | 'wav'>('mp3');
  const [result, setResult] = useState<ExportView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [t, l] = await Promise.all([
        apiFetch<TrackDetail>(`/v1/tracks/${id}`),
        apiFetch<LicenseSnapshotView>(`/v1/tracks/${id}/license`).catch(() => null),
      ]);
      setTrack(t);
      setLicence(l);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Keep the start inside the track when the length changes.
   *
   * This used to read "a 30s export always covers the whole track, so the
   * start is pinned to 0" and did exactly that — but songs are 30 to 240
   * seconds (`contracts/generation.ts`, default 120, and Create offers up to
   * 4:00), so for anything but a 30-second song the claim was false and the
   * effect threw away the start the user had chosen. Clamping is what was
   * actually wanted, and it is right for a 30s song too: `maxStart` is 0
   * there, so the pin still happens.
   */
  useEffect(() => {
    if (!track) return;
    const max = Math.max(0, Math.floor(track.durationSeconds - clipDuration));
    setClipStart((start) => Math.min(start, max));
  }, [clipDuration, track]);

  const maxStart = track ? Math.max(0, Math.floor(track.durationSeconds - clipDuration)) : 0;

  const createExport = async () => {
    if (!id) return;
    setWorking(true);
    setError(null);
    try {
      const res = await apiFetch<ExportView>(`/v1/tracks/${id}/exports`, {
        method: 'POST',
        body: { clipStartSeconds: clipStart, clipDurationSeconds: clipDuration, fadeOut, format },
      });
      setResult(res);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setWorking(false);
    }
  };

  const redownload = async (exportId: string) => {
    setError(null);
    try {
      const res = await apiFetch<{ url: string; expiresAt: string }>(
        `/v1/exports/${exportId}/download-url`,
        { method: 'POST' },
      );
      window.location.href = res.url;
    } catch (err) {
      setError(err);
    }
  };

  if (loading) return <Loading label={t('export.loading')} />;
  if (!track) return <ErrorNotice error={error} onRetry={() => void load()} />;

  return (
    <div className="split">
      <div className="stack stack--loose">
        <div className="stack stack--tight">
          <h1 style={{ fontSize: 28, margin: 0 }}>{track.title}</h1>
          <span className="muted small">
            {t('export.originalLength')} <span className="num">{t('export.seconds', { n: track.durationSeconds.toFixed(1) })}</span>
          </span>
        </div>

        <ErrorNotice error={error} />

        <AudioPlayer id={`track-${track.trackId}`} url={track.previewUrl} label={track.title} />

        <section className="panel stack">
          <h2 style={{ fontSize: 18, margin: 0 }}>{t('export.h2')}</h2>

          <fieldset className="stack stack--tight">
            <legend>{t('export.length')}</legend>
            <div className="row">
              {([15, 30] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`btn ${clipDuration === d ? 'btn--primary' : 'btn--secondary'}`}
                  aria-pressed={clipDuration === d}
                  onClick={() => setClipDuration(d)}
                >
                  {t('export.seconds', { n: d })}
                </button>
              ))}
            </div>
          </fieldset>

          {clipDuration === 15 && (
            <div>
              <label htmlFor="start">{t('export.start')}</label>
              <input
                id="start"
                type="range"
                min={0}
                max={maxStart}
                step={0.5}
                value={clipStart}
                onChange={(e) => setClipStart(Number(e.target.value))}
                aria-valuetext={t('export.startFrom', { n: clipStart.toFixed(1) })}
              />
              <div className="row row--between small muted">
                <span className="num">{t('export.seconds', { n: clipStart.toFixed(1) })}</span>
                <span className="num">
                  {t('export.toSeconds', { n: (clipStart + clipDuration).toFixed(1) })}
                </span>
              </div>
            </div>
          )}

          <div className="checkbox-row">
            <input
              id="fade"
              type="checkbox"
              checked={fadeOut}
              onChange={(e) => setFadeOut(e.target.checked)}
            />
            <label htmlFor="fade">{t('export.fade')}</label>
          </div>

          <fieldset className="stack stack--tight">
            <legend>{t('export.format')}</legend>
            <div className="row">
              <button
                type="button"
                className={`btn ${format === 'mp3' ? 'btn--primary' : 'btn--secondary'}`}
                aria-pressed={format === 'mp3'}
                onClick={() => setFormat('mp3')}
              >
                MP3
              </button>
              {/*
                UI-07: WAV appears only when the provider actually delivers
                lossless audio. Converting an MP3 master to WAV would not improve
                anything, so it is not offered as if it did.
              */}
              {runtime?.features.wavExportEnabled ? (
                <button
                  type="button"
                  className={`btn ${format === 'wav' ? 'btn--primary' : 'btn--secondary'}`}
                  aria-pressed={format === 'wav'}
                  onClick={() => setFormat('wav')}
                >
                  WAV
                </button>
              ) : (
                <span className="small muted">{t('export.wavUnavailable')}</span>
              )}
            </div>
          </fieldset>

          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => void createExport()}
            disabled={working || track.state !== 'deliverable'}
          >
            {working ? t('export.working') : t('export.action')}
          </button>
          <p className="small muted" style={{ margin: 0 }}>
            {t('export.freeNote')}
          </p>
        </section>

        {result && (
          <section className="panel stack">
            <div className="row row--between">
              <h2 style={{ fontSize: 18, margin: 0 }}>{t('export.done')}</h2>
              {result.reused && <Badge>{t('export.reused')}</Badge>}
            </div>
            <div className="row small muted">
              <span className="num">{t('export.seconds', { n: result.clipDurationSeconds })}</span>
              <span aria-hidden="true">·</span>
              <span>{result.format.toUpperCase()}</span>
              <span aria-hidden="true">·</span>
              <span className="num">{(result.byteSize / 1024).toFixed(0)} KB</span>
            </div>
            <a className="btn btn--primary" href={result.downloadUrl}>
              {t('export.download')}
            </a>
            <p className="small muted" style={{ margin: 0 }}>
              {t('export.expires', { date: formatJst(result.downloadUrlExpiresAt) })}
            </p>
          </section>
        )}

        {track.exports.length > 0 && (
          <section className="panel stack">
            <h2 style={{ fontSize: 18, margin: 0 }}>{t('export.history')}</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{t('export.length')}</th>
                    <th>{t('export.format')}</th>
                    <th>{t('export.createdAt')}</th>
                    <th>{t('export.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {track.exports.map((e) => (
                    <tr key={e.exportId}>
                      <td className="num">
                        {t('export.range', {
                          from: e.clipStartSeconds.toFixed(1),
                          to: (e.clipStartSeconds + e.clipDurationSeconds).toFixed(1),
                        })}
                        {e.fadeOut && <span className="muted small"> · {t('export.faded')}</span>}
                      </td>
                      <td>{e.format.toUpperCase()}</td>
                      <td className="small muted">{formatJst(e.createdAt)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => void redownload(e.exportId)}
                        >
                          {t('export.redownload')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      <aside className="stack sticky-side">
        {/* UI-09: named a usage-terms record, never a copyright certificate. */}
        <section className="panel panel--tight stack stack--tight">
          <h2 style={{ fontSize: 17, margin: 0 }}>{t('export.licence.h2')}</h2>
          {!licence ? (
            <p className="small muted" style={{ margin: 0 }}>
              {t('export.licence.none')}
            </p>
          ) : (
            <>
              <div className="row row--between small">
                <span className="muted">{t('export.licence.status')}</span>
                <Badge tone={licence.status === 'active' ? 'badge--ok' : 'badge--warn'}>
                  {licence.status === 'active'
                    ? t('export.licence.active')
                    : licence.status === 'suspended'
                      ? t('export.licence.suspended')
                      : t('export.licence.revoked')}
                </Badge>
              </div>
              <div className="row row--between small">
                <span className="muted">{t('export.licence.generatedAt')}</span>
                <span>{formatJst(licence.generatedAt)}</span>
              </div>
              <div className="row row--between small">
                <span className="muted">{t('export.licence.territory')}</span>
                <span>{licence.territory}</span>
              </div>

              <div className="stack stack--tight" style={{ marginTop: 'var(--s1)' }}>
                <strong className="small">{t('export.licence.allowed')}</strong>
                <ul className="small muted" style={{ margin: 0, paddingLeft: '1.2em' }}>
                  {licence.allowedUses.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </div>

              <div className="stack stack--tight">
                <strong className="small">{t('export.licence.prohibited')}</strong>
                <ul className="small muted" style={{ margin: 0, paddingLeft: '1.2em' }}>
                  {licence.prohibitedUses.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </div>

              <hr className="divider" />
              <div className="small muted">
                <div>
                  {t('export.licence.hash')}
                  <br />
                  <code style={{ wordBreak: 'break-all', fontSize: 11 }}>{licence.sourceSha256}</code>
                </div>
              </div>
              <p className="small" style={{ margin: 0, color: 'var(--warning)' }}>
                {licence.disclaimer}
              </p>
            </>
          )}
        </section>

        <section className="panel panel--tight stack stack--tight">
          <h2 style={{ fontSize: 17, margin: 0 }}>{t('export.rights.h2')}</h2>
          <p className="small muted" style={{ margin: 0 }}>
            {t('export.rights.body')}
          </p>
          <Link className="btn btn--ghost" to="/help/rights">
            {t('rights.h1')}
          </Link>
        </section>
      </aside>
    </div>
  );
}
