import { Link } from 'react-router-dom';
import { formatTime, usePlayer } from '../lib/player';
import { CoverArt } from './CoverArt';

/**
 * The persistent player bar — the product's constant.
 *
 * Every screen leaves room for it (the layout reserves the bottom band), it
 * survives navigation, and it is the only place transport controls live. The
 * progress rail doubles as a scrubber with a 44px touch target.
 */
export function PlayerBar() {
  const player = usePlayer();
  if (!player.current) return null;

  const duration = player.duration || player.current.durationSeconds || 0;
  const progress = duration > 0 ? Math.min(player.currentTime / duration, 1) : 0;
  const pct = `${(progress * 100).toFixed(2)}%`;

  return (
    <footer className="player-bar" aria-label="Player">
      <div className="player-bar__inner">
        <Link to={`/song/${player.current.trackId}`} className="player-bar__now">
          <CoverArt seed={player.current.coverSeed} title={player.current.title} size={48} />
          <span className="player-bar__titles">
            <span className="player-bar__title">{player.current.title}</span>
            <span className="player-bar__artist">
              {player.current.artistName ?? 'Creator'} ·{' '}
              {player.current.vocalMode === 'instrumental' ? 'Instrumental' : 'Vocals'}
            </span>
          </span>
        </Link>

        <div className="player-bar__center">
          <div className="player-bar__controls">
            <button
              type="button"
              className="btn-icon"
              onClick={player.prev}
              aria-label="Previous song"
              disabled={player.queue.length === 0}
            >
              <span className="icon icon--prev" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn-icon btn-icon--main"
              onClick={player.toggle}
              aria-label={player.status === 'playing' ? 'Pause' : 'Play'}
            >
              <span
                className={player.status === 'playing' ? 'icon icon--pause' : 'icon icon--play'}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              className="btn-icon"
              onClick={player.next}
              aria-label="Next song"
              disabled={player.queue.length === 0}
            >
              <span className="icon icon--next" aria-hidden="true" />
            </button>
          </div>

          <div className="player-bar__rail">
            <span className="player-bar__time">{formatTime(player.currentTime)}</span>
            <label className="sr-only" htmlFor="player-seek">
              Seek
            </label>
            <input
              id="player-seek"
              type="range"
              min={0}
              max={Math.max(duration, 0.1)}
              step={0.1}
              value={Math.min(player.currentTime, duration)}
              onChange={(e) => player.seek(Number(e.target.value))}
              className="player-bar__seek"
              style={{ '--progress': pct } as React.CSSProperties}
              aria-valuetext={`${formatTime(player.currentTime)} of ${formatTime(duration)}`}
            />
            <span className="player-bar__time">{formatTime(duration)}</span>
          </div>
        </div>

        <div className="player-bar__right">
          {player.status === 'loading' && <span className="player-bar__hint">buffering…</span>}
          {player.status === 'error' && <span className="player-bar__hint player-bar__hint--err">playback error</span>}
          {player.queue.length > 0 && (
            <span className="player-bar__queue" title="Songs in queue">
              <span className="icon icon--queue" aria-hidden="true" /> {player.queue.length}
            </span>
          )}
        </div>
      </div>
    </footer>
  );
}
