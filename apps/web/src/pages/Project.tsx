import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { SCENE_KEY, TRACK_MOOD_KEY, TRACK_STATE_KEY, TRACK_STATE_TONES } from '../lib/messages';
import { formatJst, useSession } from '../lib/session';
import { usePlayer } from '../lib/player';
import { AudioPlayer, Badge, ErrorNotice, Loading } from '../components/common';

interface ProjectTrack {
  trackId: string;
  title: string;
  state: string;
  mood: string | null;
  durationSeconds: number;
  createdAt: string;
}

interface ProjectView {
  projectId: string;
  title: string;
  scene: string;
  createdAt: string;
  tracks: ProjectTrack[];
}

interface TrackDetail {
  trackId: string;
  previewUrl: string | null;
}

/**
 * UI-05: version comparison.
 *
 * Each card here is one generation the user paid for. The page never implies
 * that a single charge produced several options, and re-generating states the
 * additional cost before it happens.
 */
export default function Project() {
  const { t } = useI18n();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // Only the stable `stop` callback is captured: the player object's identity
  // changes on every playback tick, so depending on it here would re-run the
  // cleanup effect continuously.
  const { stop: stopPlayback } = usePlayer();
  const { entitlements, refreshEntitlements } = useSession();

  const [project, setProject] = useState<ProjectView | null>(null);
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const p = await apiFetch<ProjectView>(`/v1/projects/${id}`);
      setProject(p);
      setSelected((cur) => cur ?? p.tracks[0]?.trackId ?? null);

      // Preview URLs are short-lived and issued per read (SEC-04).
      const urls: Record<string, string | null> = {};
      await Promise.all(
        p.tracks.map(async (t) => {
          try {
            const detail = await apiFetch<TrackDetail>(`/v1/tracks/${t.trackId}`);
            urls[t.trackId] = detail.previewUrl;
          } catch {
            urls[t.trackId] = null;
          }
        }),
      );
      setPreviews(urls);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Stop playback when leaving the page (UI-01).
  useEffect(() => () => stopPlayback(), [stopPlayback]);

  const regenerate = () => {
    // UI-05: the extra cost is confirmed explicitly, never charged silently.
    const available = entitlements?.availableUnits ?? 0;
    const ok = window.confirm(
      t('project.regen.confirm', { now: available, after: Math.max(0, available - 1) }),
    );
    if (ok) navigate(`/create?scene=${encodeURIComponent(project?.scene ?? 'night_walk')}`);
  };

  if (loading) return <Loading label={t('project.loading')} />;
  if (error) return <ErrorNotice error={error} onRetry={() => void load()} />;
  if (!project) return null;

  const sceneLabel = t(SCENE_KEY(project.scene));

  return (
    <div className="stack stack--loose">
      <div className="row row--between">
        <div className="stack stack--tight">
          <h1 style={{ fontSize: 28, margin: 0 }}>{project.title}</h1>
          <span className="muted small">
            {t('project.created', { scene: sceneLabel, date: formatJst(project.createdAt, false) })}
          </span>
        </div>
        <Link className="btn btn--ghost" to="/library">
          {t('project.allWorks')}
        </Link>
      </div>

      {project.tracks.length === 0 ? (
        <div className="empty">
          <p>{t('project.empty')}</p>
          <Link className="btn btn--primary" to="/create">
            {t('project.create')}
          </Link>
        </div>
      ) : (
        <div className="grid">
          {project.tracks.map((track, index) => {
            const state = { label: t(TRACK_STATE_KEY(track.state)), tone: TRACK_STATE_TONES[track.state] ?? '' };
            const isSelected = selected === track.trackId;
            return (
              <article
                key={track.trackId}
                className="card"
                style={isSelected ? { borderColor: 'var(--accent)' } : undefined}
              >
                <div className="row row--between">
                  <strong>{track.title}</strong>
                  <Badge tone={state.tone}>{state.label}</Badge>
                </div>

                <div className="row small muted">
                  <span>{t('project.version', { n: index + 1 })}</span>
                  <span aria-hidden="true">·</span>
                  <span className="num">{t('project.seconds', { n: track.durationSeconds.toFixed(1) })}</span>
                  {track.mood && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{t(TRACK_MOOD_KEY(track.mood))}</span>
                    </>
                  )}
                </div>

                <AudioPlayer
                  id={`track-${track.trackId}`}
                  url={previews[track.trackId] ?? null}
                  label={track.title}
                />

                <div className="row">
                  <button
                    type="button"
                    className={`btn ${isSelected ? 'btn--primary' : 'btn--secondary'}`}
                    onClick={() => setSelected(track.trackId)}
                    aria-pressed={isSelected}
                  >
                    {isSelected ? t('project.selected') : t('project.select')}
                  </button>
                  {track.state === 'deliverable' && (
                    <Link className="btn btn--secondary" to={`/tracks/${track.trackId}/export`}>
                      {t('project.export')}
                    </Link>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <section className="panel stack">
        <h2 style={{ fontSize: 18, margin: 0 }}>{t('project.regen.h2')}</h2>
        <p className="muted small" style={{ margin: 0 }}>
          {t('project.regen.hint')}
        </p>
        <div className="row">
          <button type="button" className="btn btn--secondary" onClick={regenerate}>
            {t('project.regen.action')}
          </button>
          <span className="small muted">
            {t('project.remaining', { n: entitlements?.availableUnits ?? 0 })}
          </span>
          <button type="button" className="btn btn--ghost" onClick={() => void refreshEntitlements()}>
            {t('project.refresh')}
          </button>
        </div>
      </section>
    </div>
  );
}
