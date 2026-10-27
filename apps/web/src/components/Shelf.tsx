import { useEffect, useRef, useState, type ReactNode } from 'react';
import { shelfEdges, shelfStep } from '../lib/shelf';

/**
 * A row of cards that scrolls sideways, and says when it runs past the edge:
 * the side with more fades out, and two arrows beside the heading move a page
 * at a time. The arrows appear only when the row overflows, and each is
 * disabled at its own end. Touch screens swipe; there the fade is the cue.
 */
export function Shelf({ head, rowClass, prevLabel, nextLabel, children }: {
  head: ReactNode;
  rowClass: string;
  prevLabel: string;
  nextLabel: string;
  children: ReactNode;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ before: false, after: false });

  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => {
      const next = shelfEdges(el);
      setEdges((prev) => (prev.before === next.before && prev.after === next.after ? prev : next));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, []);

  const move = (dir: -1 | 1) => {
    const el = row.current;
    if (!el) return;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollBy({ left: dir * shelfStep(el.clientWidth), behavior: still ? 'auto' : 'smooth' });
  };

  const overflows = edges.before || edges.after;
  return (
    <>
      <div className="shelf__head">
        <div className="shelf__title">{head}</div>
        {overflows && (
          <div className="shelf__nav">
            <button type="button" className="shelf__arrow" aria-label={prevLabel} disabled={!edges.before} onClick={() => move(-1)}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7" /></svg>
            </button>
            <button type="button" className="shelf__arrow" aria-label={nextLabel} disabled={!edges.after} onClick={() => move(1)}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>
        )}
      </div>
      <div ref={row} className={`${rowClass} shelf__row`} data-before={edges.before || undefined} data-after={edges.after || undefined}>
        {children}
      </div>
    </>
  );
}
