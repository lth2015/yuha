import { Link, useNavigate } from 'react-router-dom';
import { useI18n } from '../lib/i18n';
import { SCENES, sceneBySlug, sceneCreateHref, type SceneSlug } from '../lib/scenes';
import { useSession } from '../lib/session';

/**
 * One scene landing page (docs/GROWTH_SPEC.md, part one): what a song can do
 * at a birthday, a confession, a goodbye, and one button into /create with
 * that occasion chosen. Public and prerendered (lib/seo.ts), so it renders in
 * full with no session and no API: the free-songs line is the only part that
 * waits for the server, because whether it is true is the server's to say.
 *
 * Examples are the product owner's own songs (lib/scenes.ts). No counts of
 * any kind: no plays, no likes (CLAUDE.md, Scope decisions).
 */
export default function ScenePage({ slug }: { slug: SceneSlug }) {
  const { t } = useI18n();
  const { runtime, me } = useSession();
  const navigate = useNavigate();
  /*
   * Signed out, with trials open: the home page lets a visitor make a song
   * with no account, and this page sent the same visitor straight to sign-up.
   * The trial goes from here too, starting from this scene's first line.
   */
  const canTry = !me && runtime?.features.guestTrialEnabled === true;
  const tryFirst = () => {
    try {
      localStorage.setItem('yuha.home-draft', t(scene.starters[0] ?? scene.title));
    } catch {
      /* the home page still opens; the box is empty */
    }
    navigate('/');
  };
  const scene = sceneBySlug(slug)!;
  const trialUnits = runtime?.features.freeTrialEnabled ? runtime.features.freeTrialUnits : 0;

  return (
    <div className={`scene scene--${slug}`}>
      <section className="scene__hero" aria-labelledby="scene-title">
        {/* Codex's illustration (PR #96): one object, decorative; the words carry the page. */}
        <img className="scene__art" src={`/scene/${slug}.svg`} width={320} height={240} alt="" aria-hidden="true" />
        <div className="scene__intro">
        <span className="scene__kicker">{t(scene.kicker)}</span>
        <h1 id="scene-title">{t(scene.title)}</h1>
        <p className="scene__body">{t(scene.body)}</p>
        <Link className="btn btn--primary btn--lg" to={sceneCreateHref(scene)}>
          {t(scene.cta)}
        </Link>
        {canTry && (
          <button type="button" className="btn btn--lg scene__try" onClick={tryFirst}>
            {t('scene.tryFirst')}
          </button>
        )}
        {trialUnits > 0 && <p className="scene__note">{t('scene.free', { n: trialUnits })}</p>}
        </div>
      </section>

      <section className="scene__section" aria-labelledby="scene-starters">
        <h2 id="scene-starters">{t('scene.starters.title')}</h2>
        <div className="scene__starters">
          {scene.starters.map((key) => (
            <Link key={key} className="chip chip--btn" to={sceneCreateHref(scene, key)}>
              {t(key)}
            </Link>
          ))}
        </div>
      </section>

      <section className="scene__section" aria-labelledby="scene-how">
        <h2 id="scene-how">{t('scene.how.title')}</h2>
        <ol className="scene__steps">
          <li>{t('scene.how.1')}</li>
          <li>{t('scene.how.2')}</li>
          <li>{t('scene.how.3')}</li>
        </ol>
      </section>

      {scene.examples.length > 0 && (
        <section className="scene__section" aria-labelledby="scene-examples">
          <h2 id="scene-examples">{t('scene.examples.title')}</h2>
          <ul className="scene__examples">
            {scene.examples.map((ex) => (
              <li key={ex.trackId}>
                <Link to={`/song/${ex.trackId}`}>
                  <strong>{ex.title}</strong>
                  <span>{ex.line}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <nav className="scene__section scene__more" aria-labelledby="scene-more">
        <h2 id="scene-more">{t('scene.more')}</h2>
        <ul>
          {SCENES.filter((s) => s.slug !== slug).map((s) => (
            <li key={s.slug}>
              <Link to={`/${s.slug}`}>{t(s.name)}</Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
