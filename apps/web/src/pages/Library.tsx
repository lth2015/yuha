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
        <h1>我的作品</h1>
        <Link to="/create" className="btn btn--primary btn--sm">
          <span className="icon icon--create" aria-hidden="true" />
          新的创作
        </Link>
      </div>

      {earnings && earnings.sales > 0 && (
        <section className="panel earnings" aria-labelledby="earnings-heading">
          <div className="earnings__head">
            <h2 id="earnings-heading">市场收益</h2>
            <span className="small muted">每笔授权你获得 {Math.round(earnings.creatorShareRate * 100)}%</span>
          </div>
          <div className="earnings__row">
            <div className="earnings__figure">
              <strong className="earnings__total">
                ${(earnings.totalMinor / 100).toFixed(2)}
              </strong>
              <span className="small muted">累计收益 · {earnings.sales} 笔</span>
            </div>
            <div className="earnings__breakdown">
              <span className="chip">${(earnings.pendingMinor / 100).toFixed(2)} 待结算</span>
              <span className="chip">${(earnings.clearedMinor / 100).toFixed(2)} 已结算</span>
              <span className="chip">${(earnings.paidMinor / 100).toFixed(2)} 已支付</span>
            </div>
          </div>
          {earnings.perTrack.length > 0 && (
            <ul className="earnings__tracks">
              {earnings.perTrack.slice(0, 5).map((t) => (
                <li key={t.trackId}>
                  <Link to={`/song/${t.trackId}`}>{t.title}</Link>
                  <span className="small muted">
                    {t.sales} 份授权 · ${(t.amountMinor / 100).toFixed(2)}
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
            placeholder="搜索你的作品…"
            aria-label="搜索你的作品"
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
          <h2>还没有作品</h2>
          <p>生成过的音乐会出现在这里——默认私密，发布前只有你能看到。</p>
          <Link className="btn btn--primary" to="/create">
            开始第一段创作
          </Link>
        </div>
      ) : (
        <>
          <div className="masonry">
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
                {loadingMore ? '加载中…' : '加载更多'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
