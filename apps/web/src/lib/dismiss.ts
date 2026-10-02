import { useEffect, type RefObject } from 'react';

/**
 * Closes a popup on an outside click or Escape.
 *
 * Written down once because it had been written twice and missed a third
 * time. `ShareMenu` had it from the start, the account menu grew it after a
 * panel was found floating over the page with `aria-expanded="true"` until
 * you went back and found the avatar again, and the song card's menu — the
 * one on every card in the library — never had it at all. A rule that lives
 * in three copies is a rule that is only true in two of them.
 *
 * `pointerdown`, not `click`: a menu that waits for the full click leaves the
 * panel open under the finger through the press, and on touch that reads as
 * the tap having missed.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, open, close]);
}
