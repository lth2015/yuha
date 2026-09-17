import { useCallback, useEffect, useState } from 'react';
import type { TrackView } from '@loopscene/contracts';
import { apiFetch } from '../lib/api';
import { ErrorNotice } from '../components/common';
import { SongCard } from '../components/SongCard';

type Sort = 'trending' | 'new';
type VocalFilter = 'instrumental' | 'vocals' | undefined;

/**
 * Explore: the public feed. Anonymous visitors can listen; liking asks for an
 * account. Filters and search hit the same endpoint with cursor pagination.
 */
export default function Explore() {
  const [songs, setSongs] = useState<TrackView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('trending');
  const [vocal, setVocal] = useState<VocalFilter>(undefined);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(
    async (params: { sort: Sort; vocal: VocalFilter; q: string; cursor?: string }) => {
      const search = new URLSearchParams({ limit: '24', sort: params.sort });
      if (params.vocal) search.set('vocal', params.vocal);
      if (params.q) search.set('q', params.q);
      if (params.cursor) search.set('cursor', params.cursor);
      return apiFetch<{ items: TrackView[]; nextCursor: string | null }>(`/v1/explore?${search.toString()}`);
    },
    [],
  );

  // Reload on filter change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    load({ sort, vocal, q: query })
      .then((r) => {
        if (cancelled) return;
        setSongs(r.items);
        setCursor(r.nextCursor);
      })
      .catch((err) => !cancelled && setError(err))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [load, sort, vocal, query]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await load({ sort, vocal, q: query, cursor });
      setSongs((prev) => [...prev, ...r.items]);
      setCursor(r.nextCursor);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  };

  const chips: Array<{ label: string; value: VocalFilter }> = [
    { label: 'All', value: undefined },
    { label: 'Instrumental', value: 'instrumental' },
    { label: 'With vocals', value: 'vocals' },
  ];

  return (
    <div className="stack">
      <div className="section-head">
        <h1>Explore</h1>
        <div className="seg" role="tablist" aria-label="Sort">
          {(['trending', 'new'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={sort === s}
              className={`seg__btn${sort === s ? ' is-active' : ''}`}
              onClick={() => setSort(s)}
            >
              {s === 'trending' ? 'Trending' : 'Newest'}
            </button>
          ))}
        </div>
      </div>

      <form
        className="explore-controls"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <div className="chips" role="group" aria-label="Filter">
          {chips.map((c) => (
            <button
              key={c.label}
              type="button"
              className={`chip chip--btn${vocal === c.value ? ' is-on' : ''}`}
              aria-pressed={vocal === c.value}
              onClick={() => setVocal(c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="explore-search">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search songs or styles…"
            aria-label="Search songs"
            enterKeyHint="search"
          />
          <button type="submit" className="btn btn--sm" disabled={q.trim() === query}>
            Search
          </button>
        </div>
      </form>

      <ErrorNotice error={error} />

      {loading ? (
        <div className="grid grid--songs" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skeleton skeleton--card" />
          ))}
        </div>
      ) : songs.length === 0 ? (
        <div className="empty">
          <p>No songs match yet. Try another filter — or make the song that belongs here.</p>
        </div>
      ) : (
        <>
          <div className="grid grid--songs">
            {songs.map((song) => (
              <SongCard key={song.trackId} song={song} queue={songs} />
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
