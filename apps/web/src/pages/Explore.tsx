import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrackView } from '@loopscene/contracts';
import { apiFetch } from '../lib/api';
import { formatTime, usePlayer } from '../lib/player';
import { CoverArt } from '../components/CoverArt';
import { ErrorNotice } from '../components/common';
import { SongCard } from '../components/SongCard';

type Sort = 'trending' | 'new';
type VocalFilter = 'instrumental' | 'vocals' | undefined;

/**
 * The Market — SONARE's own operated chart.
 *
 * Two acts: a ranked Top 10 (big numerals, the chart register) and Fresh
 * drops beneath it. Genre chips are derived from what the feed actually
 * carries, not a fixed list. Anonymous visitors can audition everything;
 * liking asks for an account.
 */
export default function Explore() {
  const player = usePlayer();
  const [songs, setSongs] = useState<TrackView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('trending');
  const [vocal, setVocal] = useState<VocalFilter>(undefined);
  const [genre, setGenre] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(
    async (params: { sort: Sort; vocal: VocalFilter; q: string; cursor?: string }) => {
      const search = new URLSearchParams({ limit: '30', sort: params.sort });
      if (params.vocal) search.set('vocal', params.vocal);
      if (params.q) search.set('q', params.q);
      if (params.cursor) search.set('cursor', params.cursor);
      return apiFetch<{ items: TrackView[]; nextCursor: string | null }>(`/v1/explore?${search.toString()}`);
    },
    [],
  );

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

  // Genre chips are derived from what is actually on the chart.
  const genres = useMemo(() => {
    const counts = new Map<string, number>();
    for (const song of songs) for (const style of song.styles) counts.set(style, (counts.get(style) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([style]) => style);
  }, [songs]);

  const shown = useMemo(
    () => (genre ? songs.filter((s) => s.styles.includes(genre)) : songs),
    [songs, genre],
  );
  const chart = shown.slice(0, 10);
  const fresh = shown.slice(10);

  const reportPlay = (id: string) => {
    void apiFetch(`/v1/explore/${id}/plays`, { method: 'POST' }).catch(() => undefined);
  };

  const playChartRow = (song: TrackView, queue: TrackView[]) => {
    if (!song.previewUrl) return;
    reportPlay(song.trackId);
    player.play(
      { ...song, previewUrl: song.previewUrl },
      queue.filter((s) => s.previewUrl).map((s) => ({ ...s, previewUrl: s.previewUrl! })),
    );
  };

  const chips: Array<{ label: string; value: VocalFilter }> = [
    { label: 'All', value: undefined },
    { label: 'Instrumental', value: 'instrumental' },
    { label: 'With vocals', value: 'vocals' },
  ];

  return (
    <div className="stack">
      <div className="market-head">
        <div>
          <p className="market-head__eyebrow">YUHA 市场</p>
          <h1>大家做出来的榜单</h1>
          <p className="market-head__sub">
            这里的每一首作品都由 YUHA 创作者生成并发布到市场。可以试听、喜欢，也可以带着灵感去做你自己的版本。
          </p>
        </div>
        <div className="seg" role="tablist" aria-label="Sort">
          {(['trending', 'new'] as const).map((sv) => (
            <button
              key={sv}
              type="button"
              role="tab"
              aria-selected={sort === sv}
              className={`seg__btn${sort === sv ? ' is-active' : ''}`}
              onClick={() => setSort(sv)}
            >
              {sv === 'trending' ? '热度' : '最新'}
            </button>
          ))}
        </div>
      </div>

      <form
        className="explore-controls"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
          setGenre(null);
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
          {genres.length > 0 && <span className="chips__divider" aria-hidden="true" />}
          {genres.map((g) => (
            <button
              key={g}
              type="button"
              className={`chip chip--btn${genre === g ? ' is-on' : ''}`}
              aria-pressed={genre === g}
              onClick={() => setGenre(genre === g ? null : g)}
            >
              {g}
            </button>
          ))}
        </div>
        <div className="explore-search">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索作品或风格…"
            aria-label="搜索作品"
            enterKeyHint="search"
          />
          <button type="submit" className="btn btn--sm" disabled={q.trim() === query}>
            Search
          </button>
        </div>
      </form>

      <ErrorNotice error={error} />

      {loading ? (
        <div className="chart" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="chart__row chart__row--skeleton skeleton" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <p>暂时没有匹配的作品。换个筛选试试——或者去做那首属于这里的歌。</p>
        </div>
      ) : (
        <>
          <section aria-labelledby="chart-heading" className="chart">
            <div className="section-head">
              <h2 id="chart-heading">前十</h2>
              <span className="small muted">按播放与喜欢排序</span>
            </div>
            <ol className="chart__list">
              {chart.map((song, i) => {
                const active = player.activeId === song.trackId;
                const playing = active && player.status === 'playing';
                return (
                  <li
                    key={song.trackId}
                    className={`chart__row${active ? ' is-active' : ''}`}
                    style={{ '--i': i } as React.CSSProperties}
                  >
                    <span className={`chart__rank${i < 3 ? ` chart__rank--${i + 1}` : ''}`}>
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <button
                      type="button"
                      className="chart__play"
                      onClick={() => (active ? player.toggle() : playChartRow(song, shown))}
                      disabled={!song.previewUrl}
                      aria-label={playing ? `暂停「${song.title}」` : `播放「${song.title}」`}
                    >
                      <CoverArt seed={song.coverSeed} title={song.title} size={112} />
                      <span className="chart__play-icon" data-playing={playing || undefined} aria-hidden="true">
                        {playing ? '❚❚' : '▶'}
                      </span>
                    </button>
                    <div className="chart__meta">
                      <Link to={`/song/${song.trackId}`} className="chart__title">
                        {song.title}
                      </Link>
                      <span className="chart__artist">
                        {song.artistName ?? '创作者'} · {song.vocalMode === 'instrumental' ? '纯音乐' : '有人声'} ·{' '}
                        {formatTime(song.durationSeconds)}
                      </span>
                    </div>
                    <div className="chart__tags">
                      {song.styles.slice(0, 2).map((style) => (
                        <span key={style} className="chip">
                          {style}
                        </span>
                      ))}
                    </div>
                    <span className="chart__stats num" aria-label={`${song.playCount} 次播放，${song.likeCount} 个喜欢`}>
                      {song.playCount.toLocaleString()} ▶ · {song.likeCount.toLocaleString()} ♥
                    </span>
                    <ChartLikeButton song={song} />
                  </li>
                );
              })}
            </ol>
          </section>

          {fresh.length > 0 && (
            <section aria-labelledby="fresh-heading">
              <div className="section-head">
                <h2 id="fresh-heading">新上架</h2>
              </div>
              <div className="masonry">
                {fresh.map((song, i) => (
                  <SongCard key={song.trackId} song={song} queue={fresh} index={i} />
                ))}
              </div>
            </section>
          )}

          {cursor && !genre && (
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

/** Like control detached from the card grid, for chart rows. */
function ChartLikeButton({ song }: { song: TrackView }) {
  const [liked, setLiked] = useState<boolean>(song.likedByMe ?? false);
  const [count, setCount] = useState(song.likeCount);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy || song.likedByMe === null) return;
    setBusy(true);
    setLiked(!liked);
    try {
      const res = await apiFetch<{ liked: boolean; likeCount: number }>(`/v1/explore/${song.trackId}/like`, {
        method: 'POST',
        body: { action: liked ? 'unlike' : 'like' },
      });
      setLiked(res.liked);
      setCount(res.likeCount);
    } catch {
      setLiked(liked);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className={`like-btn${liked ? ' like-btn--on' : ''}`}
      onClick={toggle}
      disabled={busy || song.likedByMe === null}
      aria-pressed={liked ?? undefined}
      aria-label={liked ? `取消喜欢「${song.title}」` : `喜欢「${song.title}」`}
    >
      <span className="icon icon--heart" aria-hidden="true" /> {count}
    </button>
  );
}
