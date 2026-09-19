import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrackView } from '@loopscene/contracts';
import { apiFetch } from '../lib/api';
import { usePlayer } from '../lib/player';
import { useSession } from '../lib/session';
import { CoverArt } from '../components/CoverArt';
import { SongCard } from '../components/SongCard';
import { Eq } from '../components/Eq';
import { WaveField } from '../components/WaveField';

/**
 * Landing page: what the product is, one song-creation CTA, and the live
 * Explore feed already playing beneath it. Visitors can audition songs before
 * signing in — the account comes at the moment of creation, not before.
 */
export default function Home() {
  const { me } = useSession();
  const player = usePlayer();
  const [songs, setSongs] = useState<TrackView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const playing = player.status === 'playing';
  const collageSongs = (songs ?? []).slice(0, 3);

  useEffect(() => {
    apiFetch<{ items: TrackView[] }>('/v1/explore?limit=8&sort=trending')
      .then((r) => setSongs(r.items))
      .catch(() => setFailed(true));
  }, []);

  return (
    <div className="stack stack--loose">
      <section className="hero">
        <div className="hero__glow" aria-hidden="true" />
        <WaveField active={playing} className="hero__waves" />
        <div className="hero__inner hero__grid">
          <div className="hero__copy">
            <p className="hero__eyebrow">AI song studio</p>
            {/* A deliberate two-line lockup: the gradient word owns its line. */}
            <h1 className="hero__title">
              Any song you can
              <em>describe.</em>
            </h1>
            <p className="hero__sub">
              Write an idea, pick a vibe, get a finished song — lyrics sung or instrumental, up to four
              minutes, yours to publish and download.
            </p>
            <div className="hero__cta">
              <Link className="btn btn--primary btn--lg" to={me ? '/create' : '/auth?next=/create'}>
                <span className="icon icon--create" aria-hidden="true" />
                Create a song
              </Link>
              <Link className="btn btn--ghost btn--lg" to="/explore">
                Browse the Market
              </Link>
            </div>
            <div className="hero__stats" aria-label="Product facts">
              <div>
                <strong>30s – 4min</strong>
                <span>song length</span>
              </div>
              <div>
                <strong>Vocals / instrumental</strong>
                <span>your lyrics or ours</span>
              </div>
              <div>
                <strong>MP3 download</strong>
                <span>publish to Explore</span>
              </div>
            </div>
          </div>

          {/* Real covers from the feed, fanned in 3D — the product showcasing itself. */}
          <div className="hero__collage" aria-hidden="true">
            {(collageSongs.length ? collageSongs : [0, 1, 2].map((i) => ({ coverSeed: 1000 + i * 77, title: 'SONARE' }))).map(
              (song, i) => (
                <div key={song.coverSeed} className={`hero__card hero__card--${i}`}>
                  <CoverArt seed={song.coverSeed} title={song.title} size={420} />
                </div>
              ),
            )}
            <div className="hero__collage-badge">
              <Eq live={playing} /> {songs?.length ?? 0}+ songs made here
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="trending-heading">
        <div className="section-head">
          <h2 id="trending-heading">
            <Eq live={playing || (songs !== null && songs.length > 0)} /> Trending now
          </h2>
          <Link to="/explore" className="section-head__more">
            See all
          </Link>
        </div>
        {failed ? (
          <div className="empty">
            <p>The feed could not be loaded right now. Please refresh in a moment.</p>
          </div>
        ) : songs === null ? (
          <div className="grid grid--songs" aria-hidden="true">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="skeleton skeleton--card" />
            ))}
          </div>
        ) : songs.length === 0 ? (
          <div className="empty">
            <p>Nothing published yet — be the first to share a song.</p>
            <Link className="btn btn--primary" to={me ? '/create' : '/auth?next=/create'}>
              Create the first one
            </Link>
          </div>
        ) : (
          <div className="grid grid--songs">
            {songs.map((song, i) => (
              <SongCard key={song.trackId} song={song} queue={songs} index={i} />
            ))}
          </div>
        )}
      </section>

      <section className="how" aria-labelledby="how-heading">
        <h2 id="how-heading">How it works</h2>
        <ol className="how__steps">
          <li>
            <strong>Describe it.</strong> “A dreamy synthwave night drive with airy vocals” — or paste your own
            lyrics.
          </li>
          <li>
            <strong>Shape it.</strong> Style tags, energy, length, vocals on or off. One credit generates one song.
          </li>
          <li>
            <strong>Release it.</strong> Listen in the app, download the MP3, publish it to Explore with one tap.
          </li>
        </ol>
      </section>
    </div>
  );
}
