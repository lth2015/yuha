import { Link } from 'react-router-dom';
import { useI18n } from '../lib/i18n';

/**
 * The page for an address that leads nowhere.
 *
 * This was inline in App.tsx as `<h2>Page not found</h2>` plus a sentence
 * telling people to "head back to Create" — in English under a Japanese or
 * Chinese header, with no h1 above the h2, and with no link to the place it
 * told them to go. Three defects in four lines, and none of them visible to
 * the i18n checker, which until the same change only recognised hardcoded
 * text when it contained CJK characters.
 */
export default function NotFound() {
  const { t } = useI18n();
  return (
    <div className="empty">
      <h1>{t('title.notFound')}</h1>
      <p>{t('notFound.body')}</p>
      <Link className="btn btn--primary" to="/create">
        {t('notFound.back')}
      </Link>
    </div>
  );
}
