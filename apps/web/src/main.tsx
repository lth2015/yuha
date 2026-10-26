import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@app-entry';
import { airRedirect } from './lib/air-redirect';
import './styles.css';

// Before React, so /air never renders a header, asks for a session or shows
// the consent gate on its way to a page that needs none of them.
const air = airRedirect(location.pathname, location.hash);
if (air) {
  location.replace(air);
} else {
  const root = document.getElementById('root');
  if (!root) throw new Error('#root is missing from index.html');

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
