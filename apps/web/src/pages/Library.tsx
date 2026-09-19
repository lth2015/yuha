import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrackView } from '@loopscene/contracts';
import { apiFetch } from '../lib/api';
import { ErrorNotice } from '../components/common';
import { SongCard } from '../components/SongCard';

interface EarningsSummary {
  currency: string;
  creatorShareRate: number;
  totalMinor: number;
  pendingMinor: number;
  clearedMinor: number;
  paidMinor: number;
  sales: number;
  perTrack: Array<{ trackId: string; title: string; sales: number; amountMinor: number }>;
}

type Filter = 'all' | 'processing' | 'deliverable' | 'suspended';

/**
 * Your songs. Only the signed-in creator's work is ever listed here; the API
 * enforces that server-side (UI-08 heritage) — this page just renders it.
 */
export default function Library() {
  const [earnings, setEarnings] = useState<EarningsSummary | null>(null);
  const [songs, setSongs] = useState<TrackView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (params?: { cursor?: string }) => {
    const search = new URLSearchParams({ limit: '24' });
    if (filter !== 'all') search.set('state', filter);
    if (q.trim()) search.set('q', q.trim());
    if (params?.cursor) search.set('cursor', params.cursor);
    return apiFetch<{ items: TrackView[]; nextCursor: string | null }>(`/v1/tracks?${search.toString()}`);
  }, [filter, q]);

  useEffect(() => {
    apiFetch<EarningsSummary>('/v1/market/earnings').then(setEarnings).catch(() => setEarnings(null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSongs(null);
    load()
      .then((r) => {
        if (cancelled) return;
        setSongs(r.items);
        setCursor(r.nextCursor);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [load]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await load({ cursor });
      setSongs((prev) => [...(prev ?? []), ...r.items]);
      setCursor(r.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  const filters: Array<{ label: string; value: Filter }> = [
    { label: 'All', value: 'all' },
    { label: 'Finished', value: 'deliverable' },
    { label: 'Generating', value: 'processing' },
    { label: 'Paused', value: 'suspended' },
  ];

  return (
    <div className="stack">
      <div className="section-head">
        <h1>Library</h1>
        <Link to="/create" className="btn btn--primary btn--sm">
          <span className="icon icon--create" aria-hidden="true" />
          New song
        </Link>
      </div>

      {earnings && earnings.sales > 0 && (
        <section className="panel earnings" aria-labelledby="earnings-heading">
          <div className="earnings__head">
            <h2 id="earnings-heading">Market earnings</h2>
            <span className="small muted">your share: {Math.round(earnings.creatorShareRate * 100)}% of each sale</span>
          </div>
          <div className="earnings__row">
            <div className="earnings__figure">
              <strong className="earnings__total">
                ${(earnings.totalMinor / 100).toFixed(2)}
              </strong>
              <span className="small muted">total earned · {earnings.sales} sale{earnings.sales === 1 ? '' : 's'}</span>
            </div>
            <div className="earnings__breakdown">
              <span className="chip">${(earnings.pendingMinor / 100).toFixed(2)} pending</span>
              <span className="chip">${(earnings.clearedMinor / 100).toFixed(2)} cleared</span>
              <span className="chip">${(earnings.paidMinor / 100).toFixed(2)} paid out</span>
            </div>
          </div>
          {earnings.perTrack.length > 0 && (
            <ul className="earnings__tracks">
              {earnings.perTrack.slice(0, 5).map((t) => (
                <li key={t.trackId}>
                  <Link to={`/song/${t.trackId}`}>{t.title}</Link>
                  <span className="small muted">
                    {t.sales} license{t.sales === 1 ? '' : 's'} · ${(t.amountMinor / 100).toFixed(2)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <div className="explore-controls">
        <div className="chips" role="group" aria-label="Filter">
          {filters.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`chip chip--btn${filter === f.value ? ' is-on' : ''}`}
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="explore-search">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search your songs…"
            aria-label="Search your songs"
          />
        </div>
      </div>

      <ErrorNotice error={error} />

      {songs === null ? (
        <div className="grid grid--songs" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton skeleton--card" />
          ))}
        </div>
      ) : songs.length === 0 ? (
        <div className="empty">
          <h2>Nothing here yet</h2>
          <p>Your generated songs live here — private until you publish them.</p>
          <Link className="btn btn--primary" to="/create">
            Create your first song
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid--songs">
            {songs.map((song, i) => (
              <SongCard
                key={song.trackId}
                song={song}
                queue={songs}
                index={i}
                onRemove={(id) => setSongs((prev) => prev?.filter((s) => s.trackId !== id) ?? null)}
              />
            ))}
          </div>
          {cursor && (
            <div className="load-more">
              <button type="button" className="btn" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
