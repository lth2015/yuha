import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { JobView, TrackView } from '@loopscene/contracts';
import { apiFetch, newIdempotencyKey } from '../lib/api';
import { usePlayer } from '../lib/player';
import { useSession } from '../lib/session';
import { PetalMark } from '../components/Brand';
import { Eq } from '../components/Eq';
import { SongCard } from '../components/SongCard';

const DRAFT_KEY = 'yuha.home-draft';

const MOODS: Record<string, string> = {
  城市散步: '城市散步，节奏轻快。干净的鼓点和柔软的合成器，像周末没安排的下午。',
  日落公路: '日落公路，朋友骑车回家。轻快一点，像风穿过衬衫。',
  房间里的雨: '房间里的雨，温暖的钢琴和轻柔的环境声。安静，但有一点期待。',
  深夜自习: '深夜自习，安静的白噪音和微弱的心跳感，专注而平静。',
};

/**
 * YUHA home — the create screen itself (acceptance UI-01): the slogan, a
 * one-line explainer, a composer with mood starters, and the fixed 30s /
 * instrumental note. Visitors can write first and sign in at submit; the
 * draft survives the round trip. Finished work surfaces beneath.
 */
export default function Home() {
  const { me, entitlements, refreshEntitlements } = useSession();
  const player = usePlayer();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [activeMood, setActiveMood] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('从一句话开始，也可以选一种心情。');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [songs, setSongs] = useState<TrackView[] | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const idemKey = useRef(newIdempotencyKey());
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const credits = entitlements?.availableUnits ?? me?.creditsAvailable ?? 0;
  const playing = player.status === 'playing';

  useEffect(() => {
    try {
      setPrompt(localStorage.getItem(DRAFT_KEY) ?? '');
    } catch {
      /* ignore */
    }
    apiFetch<{ items: TrackView[] }>('/v1/explore?limit=6&sort=trending')
      .then((r) => setSongs(r.items))
      .catch(() => setSongs([]));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, prompt);
    } catch {
      /* private browsing */
    }
  }, [prompt]);

  const canSubmit = prompt.trim().length > 0 && !submitting;

  const pickMood = (name: string) => {
    if (prompt.trim() && !Object.values(MOODS).includes(prompt)) {
      setFeedback(`已保留你的文字；可以手动补充「${name}」的感觉。`);
      return;
    }
    setPrompt(MOODS[name]!);
    setActiveMood(name);
    setFeedback('已经放入一个起点，你可以随意修改。');
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      if (!me) {
        const next = encodeURIComponent('/');
        navigate(`/auth?next=${next}`);
        return;
      }
      const res = await apiFetch<JobView & { deduplicated: boolean }>('/v1/generations', {
        method: 'POST',
        idempotencyKey: idemKey.current,
        body: {
          mode: 'simple',
          prompt: prompt.trim(),
          styles: activeMood ? [activeMood] : [],
          instrumental: true,
          energy: 0.5,
          durationSeconds: 30,
          visibility: 'private',
        },
      });
      setJob(res);
      void refreshEntitlements();
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  // Poll the job to terminal state, then hand over to the song page.
  useEffect(() => {
    if (!job || ['done', 'failed'].includes(job.phase)) {
      if (job?.phase === 'done' && job.trackId) navigate(`/song/${job.trackId}`, { replace: true });
      return;
    }
    let delay = 2000;
    const tick = async () => {
      try {
        const next = await apiFetch<JobView>(`/v1/jobs/${job.jobId}`);
        setJob(next);
      } catch {
        /* transient poll failure */
      }
      if (delay < 10000) delay = Math.min(delay * 1.6, 10000);
      setTimeout(tick, delay);
    };
    const t = setTimeout(tick, delay);
    return () => clearTimeout(t);
  }, [job, navigate]);

  const waitSteps = useMemo(
    () => [
      { key: 'validating', label: '正在确认这次创作' },
      { key: 'queued', label: '已加入队列' },
      { key: 'generating', label: '正在生成你的音乐' },
      { key: 'done', label: '已完成，可以试听' },
    ],
    [],
  );

  // ---- generation state (real stages only, no fake progress) ----
  if (job) {
    const stepIdx = waitSteps.findIndex((s) => s.key === job.phase);
    return (
      <div className="wait-page" aria-live="polite">
        <PetalMark size={100} className="wait-page__mark is-moving" dim={false} title="YUHA" />
        <h1>你的音乐，正在路上。</h1>
        <p className="muted">可以离开这个页面，稍后在「我的作品」查看。</p>
        <ol className="wait-page__steps panel">
          {waitSteps.map((s, i) => (
            <li key={s.key} className={i < stepIdx ? 'is-done' : i === stepIdx ? 'is-current' : 'is-future'}>
              <span className="status-dot" aria-hidden="true" />
              {s.label}
              <b>{i < stepIdx ? '已完成' : i === stepIdx ? '进行中' : '待完成'}</b>
            </li>
          ))}
        </ol>
        {job.phase === 'failed' && (
          <p className="state-note" role="alert">
            这次没有完成，额度已按服务端确认退回。你可以修改描述后重试。
          </p>
        )}
        <Link to="/library" className="btn">
          去我的作品
        </Link>
      </div>
    );
  }

  return (
    <div className="stack">
      <section className="hero">
        <div className="hero__copy">
          <p className="eyebrow">A LITTLE FEELING. YOUR OWN SOUND.</p>
          <h1 className="hero__title">
            让心动，
            <br />
            有回声。
          </h1>
          <p className="hero__intro">写下一段心情，做成属于这一刻的音乐。</p>

          <div className="composer panel">
            <label htmlFor="home-prompt">今天，想听见什么？</label>
            <textarea
              id="home-prompt"
              ref={promptRef}
              value={prompt}
              maxLength={400}
              onChange={(e) => {
                setPrompt(e.target.value);
                if (e.target.value !== (activeMood && MOODS[activeMood])) setActiveMood(null);
              }}
              placeholder="傍晚的海边，朋友骑车回家。轻快一点，像风穿过衬衫。"
              aria-describedby="home-prompt-format home-prompt-count"
            />
            <div className="composer__meta">
              <span id="home-prompt-format">30 秒 · 纯音乐 · 仅自己可见</span>
              <span id="home-prompt-count" className="num">
                {prompt.length} / 400
              </span>
            </div>

            <div className="chips" role="group" aria-label="从一种心情开始">
              {Object.keys(MOODS).map((name) => (
                <button
                  key={name}
                  type="button"
                  className="chip chip--mood"
                  aria-pressed={activeMood === name}
                  onClick={() => pickMood(name)}
                >
                  {name}
                </button>
              ))}
            </div>

            <div className="composer__row">
              <span className="composer__cost">
                每次生成消耗 1 次额度
                <br />
                {me ? `当前可用 ${credits} 次` : '登录后可查看可用次数'}
              </span>
              <button type="button" className="btn btn--primary" onClick={submit} disabled={!canSubmit}>
                {submitting ? '正在提交…' : '生成音乐 · 1 次'}
                <span aria-hidden="true">↗</span>
              </button>
            </div>
            <p className="composer__feedback" aria-live="polite">
              {error ?? feedback}
            </p>
          </div>
        </div>

        <aside className="art-panel" aria-label="品牌意象：一片被风托起的羽花">
          <div className="art-panel__index" aria-hidden="true">
            <span>YUHA / 001</span>
            <span>FEEL SOMETHING.</span>
          </div>
          <PetalMark size={380} className="art-panel__petal is-entering" title="一片花瓣。一点风。" />
          <div className="art-panel__caption">
            <span className="art-panel__line" aria-hidden="true" />
            <h2>
              一片花瓣。
              <br />
              一点风。
            </h2>
            <p>
              把没有说出口的，
              <br />
              交给下一段旋律。
            </p>
          </div>
        </aside>
      </section>

      {songs && songs.length > 0 && (
        <section aria-labelledby="home-works">
          <div className="section-head">
            <h2 id="home-works">
              <Eq live={playing} /> 此刻的回声
            </h2>
            <Link to="/explore" className="section-head__more">
              逛逛市场 →
            </Link>
          </div>
          <div className="masonry">
            {songs.map((song, i) => (
              <SongCard key={song.trackId} song={song} queue={songs} index={i} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
