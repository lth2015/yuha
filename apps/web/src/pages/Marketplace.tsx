import { useRef, useState } from 'react';
import { BGM_GENRES, type OfficialBgmItem } from '@yuha/contracts';
import { CoverArt } from '../components/CoverArt';
import { Loading } from '../components/common';
import { OfficialBgmPreview } from '../components/OfficialBgmPreview';
import { useI18n } from '../lib/i18n';
import { OFFICIAL_BGM_CATALOG, useOfficialBgmCatalog } from '../lib/official-bgm-catalog';
import { formatTime } from '../lib/player';
import { useSession } from '../lib/session';

function Tracks({ query, selected, onSelect }: {
  query: string;
  selected: string | undefined;
  onSelect: (track: OfficialBgmItem, button: HTMLButtonElement) => void;
}) {
  const { t } = useI18n();
  const { items, pending, failed, nextOffset, retry, loadMore } = useOfficialBgmCatalog(OFFICIAL_BGM_CATALOG, query);

  return (
    <div className="stack">
      {!items.length && pending && <Loading />}
      {!items.length && !pending && !failed && (
        <p role="status" className="market-empty">{t(query ? 'market.noMatches' : 'market.empty')}</p>
      )}
      {items.length > 0 && (
        <ul className="market-tracks" aria-label={t('market.catalog')}>
          {items.map((track) => (
            <li key={track.id} className={`market-track${selected === track.id ? ' is-active' : ''}`}>
              <div className="market-track__sleeve" aria-hidden="true">
                <CoverArt title={track.title} seed={Number.parseInt(track.id.slice(0, 8), 16)} styles={[track.genre]} size={76} />
              </div>
              <div className="market-track__text">
                <h2>{track.title}</h2>
                <p className="small muted">
                  {t(`bgm.genre.${track.genre}`)} · {t(`bgm.scenario.${track.scenario}`)} · {t(`bgm.mood.${track.mood}`)}
                </p>
                <span className="small muted">{formatTime(track.durationSeconds)}</span>
              </div>
              <button type="button" className="btn market-track__play"
                aria-pressed={selected === track.id}
                aria-label={t('market.previewTrack', { title: track.title })}
                onClick={(event) => onSelect(track, event.currentTarget)}>{t('market.preview')}</button>
            </li>
          ))}
        </ul>
      )}
      {failed ? (
        <div className="market-empty">
          <p role="alert">{t('market.catalogError')}</p>
          <button type="button" className="btn" onClick={retry}>{t('market.retry')}</button>
        </div>
      ) : nextOffset !== null && (
        <button type="button" className="btn market-more" disabled={pending} onClick={loadMore}>
          {t(pending ? 'market.loadingMore' : 'market.more')}
        </button>
      )}
    </div>
  );
}

export default function Marketplace() {
  const { t } = useI18n();
  const { runtime, loading } = useSession();
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [genre, setGenre] = useState('');
  const [selected, setSelected] = useState<OfficialBgmItem | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const previewButton = useRef<HTMLButtonElement | null>(null);
  const params = new URLSearchParams();
  if (search) params.set('q', search);
  if (genre) params.set('genre', genre);
  const query = params.toString();

  return (
    <div className="market stack stack--loose">
      <header className="market-hero">
        <h1>{t('market.catalog')}</h1>
        <p>{t('market.lede')}</p>
        {runtime?.features?.officialBgmMarketplace && <p className="market-hero__note">{t('market.listeningOnly')}</p>}
      </header>
      {runtime?.features?.officialBgmMarketplace ? (
        <>
          <form className="market-filters" onSubmit={(event) => { event.preventDefault(); setSearch(text.trim()); }}>
            <label className="field">
              <span>{t('market.searchLabel')}</span>
              <input ref={searchInput} type="search" maxLength={120} value={text} placeholder={t('market.searchPlaceholder')}
                onChange={(event) => { setText(event.target.value); if (!event.target.value) setSearch(''); }} />
            </label>
            <label className="field">
              <span>{t('bgm.genre')}</span>
              <select value={genre} onChange={(event) => setGenre(event.target.value)}>
                <option value="">{t('market.allGenres')}</option>
                {BGM_GENRES.map((value) => <option key={value} value={value}>{t(`bgm.genre.${value}`)}</option>)}
              </select>
            </label>
            <button type="submit" className="btn">{t('market.search')}</button>
          </form>
          {selected && <OfficialBgmPreview key={selected.id} track={selected}
            endpoint={OFFICIAL_BGM_CATALOG} onClose={() => {
              setSelected(null);
              const focusTarget = previewButton.current?.isConnected ? previewButton.current : searchInput.current;
              focusTarget?.focus();
            }} />}
          <Tracks key={query} query={query} selected={selected?.id} onSelect={(track, button) => {
            previewButton.current = button;
            setSelected((current) => current?.id === track.id ? null : track);
          }} />
        </>
      ) : loading ? <Loading /> : <p className="market-empty">{t('market.unavailable')}</p>}
    </div>
  );
}
