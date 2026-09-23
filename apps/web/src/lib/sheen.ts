/**
 * Specular sheen: glass catches the light where you are.
 *
 * A static blur is a translucent rectangle. What makes Apple's material read
 * as glass is that the highlight moves — the surface responds to where the
 * pointer is rather than sitting still. This writes the pointer position onto
 * the glass element under it as `--mx` / `--my`, and the stylesheet renders
 * the highlight there as an extra background layer.
 *
 * One delegated listener for the whole document, coalesced to one write per
 * frame, so adding a glass surface anywhere costs nothing and needs no
 * per-component wiring. Coarse pointers get nothing: there is no hover on a
 * touch screen, and a highlight stuck wherever the last tap landed reads as a
 * rendering bug.
 */

const SHEEN_TARGETS = '.panel, .glass, .glass--raised, .composer, .song-card, .art-panel';

export function startSheen(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return () => {};

  let lit: HTMLElement | null = null;
  let pending: { el: HTMLElement; x: number; y: number } | null = null;
  let frame = 0;

  const flush = () => {
    frame = 0;
    if (!pending) return;
    const { el, x, y } = pending;
    pending = null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    el.style.setProperty('--mx', `${(((x - r.left) / r.width) * 100).toFixed(2)}%`);
    el.style.setProperty('--my', `${(((y - r.top) / r.height) * 100).toFixed(2)}%`);
  };

  const douse = () => {
    if (!lit) return;
    lit.classList.remove('is-lit');
    lit.style.removeProperty('--mx');
    lit.style.removeProperty('--my');
    lit = null;
  };

  const onMove = (e: PointerEvent) => {
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>(SHEEN_TARGETS) : null;
    if (target !== lit) {
      douse();
      lit = target;
      lit?.classList.add('is-lit');
    }
    if (!lit) return;
    pending = { el: lit, x: e.clientX, y: e.clientY };
    if (!frame) frame = requestAnimationFrame(flush);
  };

  document.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('pointerleave', douse, { passive: true });

  return () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerleave', douse);
    cancelAnimationFrame(frame);
    douse();
  };
}
