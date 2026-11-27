import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { PublicGiftView } from '@yuha/contracts';
import { CoverArt } from '../components/CoverArt';
import { Loading } from '../components/common';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatTime } from '../lib/player';
import { GIFT_ORIGIN_KEY, giftEvent } from '../lib/gift';
import { activeLineIndex, activeTrustedLine, resolveLyricTimings, trustedFlags } from '../lib/lyrics';
import { useSession } from '../lib/session';

/**
 * A music gift invitation, opened by its link (docs/GIFT_INVITATION_PLAN.md).
 *
 * No account, no sign-up prompt, nothing sold while the song plays. The page
 * says who it is for, shows the song and plays it in full — on a tap, as
 * browsers require — then the letter, then one way in: "I want to send a song
 * too". The audio address is asked for when play is pressed and asked for
 * again if it lapses; the page never holds a permanent link to the master.
 */
export default function Gift() {
  const { token = '' } = useParams();
  const { t } = useI18n();
  const [gift, setGift] = useState<PublicGiftView | null>(null);
  const [missing, setMissing] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [loading, setLoading] = useState(false);
  const started = useRef(false);
  const resigned = useRef(false);
  const strict = Boolean(useSession().runtime?.features?.lyricStrictTimeline);
  const lyricBox = useRef<HTMLOListElement | null>(null);

  /*
   * The words, following the song (recipients could not see them at all,
   * 2026-11-27). The same shared rule as the song page: only a trusted line
   * is lit; an estimate is read, not followed.
   */
  const timeline = useMemo(
    () => (gift?.song.lyrics ? resolveLyricTimings(gift.song.lyrics, gift.song.durationSeconds, gift.song.lyricTimings) : null),
    [gift],
  );
  const trusted = useMemo(() => (timeline ? trustedFlags(timeline, strict) : []), [timeline, strict]);
  const active = timeline && playing
    ? (strict ? activeTrustedLine(timeline.lines, trusted, time) : activeLineIndex(timeline.lines, time))
    : -1;
  useEffect(() => {
    const box = lyricBox.current;
    const el = active >= 0 ? (box?.children[active] as HTMLElement | undefined) : undefined;
    if (box && el) box.scrollTo({ top: Math.max(0, el.offsetTop - box.clientHeight / 3), behavior: 'smooth' });
  }, [active]);

  useEffect(() => {
    let gone = false;
    apiFetch<PublicGiftView>(`/v1/gift/${token}`)
      .then((g) => {
        if (gone) return;
        setGift(g);
        giftEvent(token, 'view');
      })
      .catch(() => !gone && setMissing(true));
    return () => {
      gone = true;
      audio.current?.pause();
    };
  }, [token]);

  const fetchSource = async () => {
    const res = await apiFetch<{ url: string }>(`/v1/gift/${token}/audio`);
    return res.url;
  };

  const toggle = async () => {
    const el = audio.current;
    if (!el) return;
    if (playing) {
      el.pause();
      return;
    }
    try {
      if (!el.src) {
        setLoading(true);
        el.src = await fetchSource();
      }
      await el.play();
      if (!started.current) {
        started.current = true;
        giftEvent(token, 'play_start');
      }
    } catch {
      setMissing(true);
    } finally {
      setLoading(false);
    }
  };
  /** The signed address lapsed: ask once for a fresh one and carry on from where it was. */
  const onError = async () => {
    const el = audio.current;
    if (!el || resigned.current) return;
    resigned.current = true;
    const at = el.currentTime;
    try {
      el.src = await fetchSource();
      el.currentTime = at;
      await el.play();
    } catch {
      setPlaying(false);
    }
  };
  const replay = () => {
    const el = audio.current;
    if (!el) return;
    el.currentTime = 0;
    void toggle();
  };

  if (missing) {
    return (
      <main className="page gift gift--missing" id="main">
        <h1>{t('gift.missing.title')}</h1>
        <p className="muted">{t('gift.missing.body')}</p>
        <Link to="/create?gift=1&src=gift-invite" className="btn btn--primary">{t('gift.cta')}</Link>
      </main>
    );
  }
  if (!gift) return <Loading />;

  const duration = gift.song.durationSeconds;
  return (
    <main className={`page gift gift--${gift.theme}`} id="main">
      <section className="gift__opening">
        <p className="gift__eyebrow">{t('gift.opening')}</p>
        <h1 className="gift__to">{gift.recipientName}</h1>
        <div className="gift__cover">
          <CoverArt seed={gift.song.coverSeed} title={gift.song.title} styles={gift.song.styles} vocalMode={gift.song.vocalMode} playing={playing} />
        </div>
        <h2 className="gift__title">{gift.song.title}</h2>
        {gift.senderName && <p className="gift__from">{t('gift.from', { name: gift.senderName })}</p>}
      </section>

      <section className="gift__player" aria-label={t('gift.player')}>
        <audio
          ref={audio}
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onEnded={() => {
            setPlaying(false);
            giftEvent(token, 'play_complete');
          }}
          onError={() => void onError()}
        />
        <button type="button" className="btn btn--primary gift__play" onClick={() => void toggle()} disabled={loading} aria-pressed={playing}>
          {loading ? t('gift.loading') : playing ? t('gift.pause') : t('gift.play')}
        </button>
        <input
          type="range"
          className="gift__seek"
          min={0}
          max={Math.max(1, Math.round(duration))}
          step={1}
          value={Math.round(time)}
          aria-label={t('gift.seek')}
          onChange={(e) => {
            const el = audio.current;
            if (el && el.src) el.currentTime = Number(e.target.value);
            setTime(Number(e.target.value));
          }}
        />
        <div className="gift__time num">
          <span>{formatTime(time)} / {formatTime(duration)}</span>
          <button type="button" className="text-action" onClick={replay}>{t('gift.replay')}</button>
        </div>
      </section>

      {timeline && timeline.lines.length > 0 && (
        <section className="gift__lyrics" aria-label={t('gift.lyrics')}>
          <ol ref={lyricBox} className="gift__lyric-lines">
            {timeline.lines.map((l, i) => (
              <li
                key={i}
                className={`gift__lyric${i === active ? ' is-active' : ''}${l.section && l.section !== timeline.lines[i - 1]?.section ? ' is-section-start' : ''}`}
                aria-current={i === active ? 'true' : undefined}
              >
                {l.text}
              </li>
            ))}
          </ol>
        </section>
      )}

      {gift.message && (
        <section className="gift__letter" aria-label={t('gift.letter')}>
          {gift.message.split('\n').map((line, i) => <p key={i}>{line}</p>)}
        </section>
      )}

      <section className="gift__onward">
        <p>{t('gift.onward')}</p>
        <Link
          to="/create?gift=1&src=gift-invite"
          className="btn btn--primary"
          onClick={() => {
            giftEvent(token, 'cta_click');
            try {
              sessionStorage.setItem(GIFT_ORIGIN_KEY, token);
            } catch {
              /* counting is best effort */
            }
          }}
        >
          {t('gift.cta')}
        </Link>
      </section>
      <p className="gift__made small muted">{t('gift.madeWith')}</p>
    </main>
  );
}
