/**
 * Air composition lives at /air/index.html, a static page published beside
 * this app (apps/air, built into dist/air by the artifact build). It shares
 * nothing with this app: no session, no consent gate, no requests.
 *
 * The edge has no directory index, so `/air` and `/air/` are paths with no
 * object behind them, and it answers those with this app's index.html. This
 * says where to send them instead: the file itself, never `/air/`, which
 * would come straight back here. The fragment carries a shared sketch and
 * must survive the hop.
 */
export const AIR_PAGE = '/air/index.html';

export function airRedirect(pathname: string, hash: string): string | null {
  return pathname === '/air' || pathname === '/air/' ? `${AIR_PAGE}${hash}` : null;
}
