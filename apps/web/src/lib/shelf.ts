/**
 * A sideways shelf (the home page's showcase): which side has more to see,
 * and how far one arrow press moves. Pure, so tests/shelf.test.ts can pin it;
 * the page only reads the element's scroll box and applies the answer.
 */
export type ShelfBox = { scrollLeft: number; clientWidth: number; scrollWidth: number };

/** Browsers stop sub-pixel short of either end; a pixel's slack keeps a fade from lingering there. */
const SLACK = 1;

export function shelfEdges({ scrollLeft, clientWidth, scrollWidth }: ShelfBox): { before: boolean; after: boolean } {
  return {
    before: scrollLeft > SLACK,
    after: scrollLeft + clientWidth < scrollWidth - SLACK,
  };
}

/** Most of a page: the card at the far edge stays in view, so you can see where you were. */
export function shelfStep(clientWidth: number): number {
  return Math.max(120, Math.round(clientWidth * 0.85));
}
