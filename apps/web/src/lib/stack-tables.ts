import { useEffect } from 'react';

/**
 * Data tables that become cards on a phone.
 *
 * A six-column order history at 360 px put the receipt link — the reason a
 * customer opens that table — off the right edge of a sideways scroller; the
 * operator console did the same to 「打开」 and 「Stripe ↗」. Below 600 px a
 * `.table-wrap--stack` table is laid out one card per row instead, each cell
 * labelled with its column (styles.css), so nothing has to be found by
 * swiping.
 *
 * The labels are copied from the table's own `<thead>` rather than written
 * again on every cell: one more place to keep a column name in step with its
 * header is one more place for them to disagree. Watched with a
 * MutationObserver because rows arrive after the first render (searches,
 * "load more"), and a cell rendered after the copy would otherwise go
 * unlabelled.
 */
export function useStackedTableLabels(): void {
  useEffect(() => {
    const label = () => {
      for (const table of document.querySelectorAll<HTMLTableElement>('.table-wrap--stack table')) {
        const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '');
        for (const row of table.querySelectorAll('tbody tr')) {
          [...row.children].forEach((cell, i) => {
            const text = heads[i] ?? '';
            if (cell.getAttribute('data-label') !== text) cell.setAttribute('data-label', text);
          });
        }
      }
    };
    label();
    // Attributes are not observed, so writing data-label cannot re-trigger it.
    const watch = new MutationObserver(label);
    watch.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => watch.disconnect();
  }, []);
}
