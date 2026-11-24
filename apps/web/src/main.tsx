import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@app-entry';
import { airRedirect } from './lib/air-redirect';
import { spaPathFor } from './lib/seo';
import { initialLang, loadLang } from './lib/i18n';
// The type, served from this site rather than from Google (index.html says why).
import '@fontsource/m-plus-2/300.css';
import '@fontsource/m-plus-2/400.css';
import '@fontsource/m-plus-2/500.css';
import '@fontsource/m-plus-2/700.css';
import './styles.css';

// A prerendered public page (`/ja/pricing.html`, src/prerender.tsx) stands for
// an app address; put that one back before the router reads the location, so
// the page that draws is the page the file was rendered from.
const spa = spaPathFor(location.pathname, location.search);
if (spa) history.replaceState(history.state, '', spa + location.hash);

// Before React, so /air never renders a header, asks for a session or shows
// the consent gate on its way to a page that needs none of them.
const air = airRedirect(location.pathname, location.hash);
if (air) {
  location.replace(air);
} else {
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing from index.html');

  // The visitor's own dictionary first (lib/i18n.tsx). Until it arrives, what
  // is in #root stays: the prerendered page, or index.html's short intro.
  const render = () =>
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  loadLang(initialLang()).then(render, render);
}
