/**
 * The home page's showcase is a sideways shelf. A shelf that runs past the edge
 * must say so: a fade on the side with more, and arrows that move one page of
 * cards. These pin when each side counts as "more", so the fade and the arrows
 * cannot claim content that is not there, nor hide content that is.
 *
 * No database: pure.
 */
import { describe, expect, it } from 'vitest';
import { shelfEdges, shelfStep } from '../apps/web/src/lib/shelf.js';

describe('which side of the shelf has more', () => {
  it('nothing either side when everything fits', () => {
    expect(shelfEdges({ scrollLeft: 0, clientWidth: 1200, scrollWidth: 1200 })).toEqual({ before: false, after: false });
  });

  it('more after, none before, at the start', () => {
    expect(shelfEdges({ scrollLeft: 0, clientWidth: 1200, scrollWidth: 1900 })).toEqual({ before: false, after: true });
  });

  it('both in the middle', () => {
    expect(shelfEdges({ scrollLeft: 300, clientWidth: 1200, scrollWidth: 1900 })).toEqual({ before: true, after: true });
  });

  it('none after at the end, even when sub-pixel scrolling stops a fraction short', () => {
    expect(shelfEdges({ scrollLeft: 699.4, clientWidth: 1200, scrollWidth: 1900 })).toEqual({ before: true, after: false });
  });

  it('a fraction past the start still counts as the start', () => {
    expect(shelfEdges({ scrollLeft: 0.6, clientWidth: 1200, scrollWidth: 1900 })).toEqual({ before: false, after: true });
  });
});

describe('how far one arrow press moves', () => {
  it('about a page, keeping the card at the edge in view so the place is not lost', () => {
    const step = shelfStep(1200);
    expect(step).toBeLessThan(1200);
    expect(step).toBeGreaterThan(1200 * 0.7);
  });

  it('never nothing, even on a narrow shelf', () => {
    expect(shelfStep(200)).toBeGreaterThan(0);
  });
});
