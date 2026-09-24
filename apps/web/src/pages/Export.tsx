import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ExportView, LicenseSnapshotView } from '@yuha/contracts';
import { apiFetch } from '../lib/api';
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

  // A 30s export always covers the whole track, so the start is pinned to 0.
  useEffect(() => {
    if (clipDuration === 30) setClipStart(0);
  }, [clipDuration]);

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

  if (loading) return <Loading label="楽曲を読み込み中" />;
  if (!track) return <ErrorNotice error={error} onRetry={() => void load()} />;

  return (
    <div className="split">
      <div className="stack stack--loose">
        <div className="stack stack--tight">
          <h1 style={{ fontSize: 28, margin: 0 }}>{track.title}</h1>
          <span className="muted small">
            元の長さ <span className="num">{track.durationSeconds.toFixed(1)}秒</span>
          </span>
        </div>

        <ErrorNotice error={error} />

        <AudioPlayer id={`track-${track.trackId}`} url={track.previewUrl} label={track.title} />

        <section className="panel stack">
          <h2 style={{ fontSize: 18, margin: 0 }}>カットして書き出す</h2>

          <fieldset className="stack stack--tight">
            <legend>長さ</legend>
            <div className="row">
              {([15, 30] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`btn ${clipDuration === d ? 'btn--primary' : 'btn--secondary'}`}
                  aria-pressed={clipDuration === d}
                  onClick={() => setClipDuration(d)}
                >
                  {d}秒
                </button>
              ))}
            </div>
          </fieldset>

          {clipDuration === 15 && (
            <div>
              <label htmlFor="start">開始位置</label>
              <input
                id="start"
                type="range"
                min={0}
                max={maxStart}
                step={0.5}
                value={clipStart}
                onChange={(e) => setClipStart(Number(e.target.value))}
                aria-valuetext={`${clipStart.toFixed(1)}秒から`}
              />
              <div className="row row--between small muted">
                <span className="num">{clipStart.toFixed(1)}秒</span>
                <span className="num">
                  〜 {(clipStart + clipDuration).toFixed(1)}秒
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
            <label htmlFor="fade">終わりを1秒フェードアウトする</label>
          </div>

          <fieldset className="stack stack--tight">
            <legend>形式</legend>
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
                <span className="small muted">
                  WAVは、供給元が非圧縮音源を提供するプランでのみ選べます。
                  MP3をWAVに変換しても音質は良くなりません。
                </span>
              )}
            </div>
          </fieldset>

          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => void createExport()}
            disabled={working || track.state !== 'deliverable'}
          >
            {working ? '書き出し中…' : '書き出してダウンロード'}
          </button>
          <p className="small muted" style={{ margin: 0 }}>
            カットと再ダウンロードでは生成回数を消費しません。元の音源はそのまま残ります。
          </p>
        </section>

        {result && (
          <section className="panel stack">
            <div className="row row--between">
              <h2 style={{ fontSize: 18, margin: 0 }}>書き出しが完了しました</h2>
              {result.reused && <Badge>既存ファイルを再利用</Badge>}
            </div>
            <div className="row small muted">
              <span className="num">{result.clipDurationSeconds}秒</span>
              <span>・</span>
              <span>{result.format.toUpperCase()}</span>
              <span>・</span>
              <span className="num">{(result.byteSize / 1024).toFixed(0)} KB</span>
            </div>
            <a className="btn btn--primary" href={result.downloadUrl}>
              ダウンロード
            </a>
            <p className="small muted" style={{ margin: 0 }}>
              ダウンロードリンクは {formatJst(result.downloadUrlExpiresAt)} まで有効です。
              期限が切れた場合は下の一覧から再取得できます。
            </p>
          </section>
        )}

        {track.exports.length > 0 && (
          <section className="panel stack">
            <h2 style={{ fontSize: 18, margin: 0 }}>書き出し履歴</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>長さ</th>
                    <th>形式</th>
                    <th>作成日時</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {track.exports.map((e) => (
                    <tr key={e.exportId}>
                      <td className="num">
                        {e.clipStartSeconds.toFixed(1)}〜{(e.clipStartSeconds + e.clipDurationSeconds).toFixed(1)}秒
                        {e.fadeOut && <span className="muted small"> ・フェード</span>}
                      </td>
                      <td>{e.format.toUpperCase()}</td>
                      <td className="small muted">{formatJst(e.createdAt)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => void redownload(e.exportId)}
                        >
                          再ダウンロード
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
          <h2 style={{ fontSize: 17, margin: 0 }}>利用条件記録</h2>
          {!licence ? (
            <p className="small muted" style={{ margin: 0 }}>
              この楽曲の利用条件記録はまだありません。
            </p>
          ) : (
            <>
              <div className="row row--between small">
                <span className="muted">状態</span>
                <Badge tone={licence.status === 'active' ? 'badge--ok' : 'badge--warn'}>
                  {licence.status === 'active' ? '有効' : licence.status === 'suspended' ? '確認中' : '取消'}
                </Badge>
              </div>
              <div className="row row--between small">
                <span className="muted">生成日時</span>
                <span>{formatJst(licence.generatedAt)}</span>
              </div>
              <div className="row row--between small">
                <span className="muted">地域</span>
                <span>{licence.territory}</span>
              </div>

              <div className="stack stack--tight" style={{ marginTop: 'var(--s1)' }}>
                <strong className="small">利用できる範囲</strong>
                <ul className="small muted" style={{ margin: 0, paddingLeft: '1.2em' }}>
                  {licence.allowedUses.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </div>

              <div className="stack stack--tight">
                <strong className="small">禁止される利用</strong>
                <ul className="small muted" style={{ margin: 0, paddingLeft: '1.2em' }}>
                  {licence.prohibitedUses.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </div>

              <hr className="divider" />
              <div className="small muted">
                <div>
                  音源ハッシュ(SHA-256):
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
          <h2 style={{ fontSize: 17, margin: 0 }}>権利について気になったら</h2>
          <p className="small muted" style={{ margin: 0 }}>
            権利に関するお申し立てや、生成結果への懸念はこちらから受け付けています。
            お申し立てに費用はかかりません。
          </p>
          <Link className="btn btn--ghost" to="/help/rights">
            権利申立・お問い合わせ
          </Link>
        </section>
      </aside>
    </div>
  );
}
