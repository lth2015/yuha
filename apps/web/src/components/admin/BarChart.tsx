import { useEffect, useRef, useState } from 'react';

/**
 * A column chart for the operator dashboard: stacked or grouped, one y-axis,
 * a hover tooltip per bucket, and a legend whenever there is more than one
 * series. Drawn in SVG so it needs no charting library in the bundle.
 *
 * Follows the house chart rules: columns at most 24px with a 4px rounded top
 * and a square baseline, a 2px surface gap between stacked segments, hairline
 * gridlines, labels in text colours (never the series colour), and only a few
 * x labels so they never collide. The numbers are always also available in
 * the table view on the dashboard — colour alone is never the only carrier.
 */
export interface Series {
  key: string;
  label: string;
  color: string;
  values: number[];
}

const HEIGHT = 200;
const PAD = { top: 12, right: 8, bottom: 24, left: 44 };

/**
 * An axis of whole, round steps. Everything charted here is a count or a yen
 * amount, so a tick at 6.3 or 18.8 is a number nobody can have; the step is
 * the smallest of 1·2·5×10ⁿ (never below 1) that covers the peak in at most
 * five intervals, and the top of the axis is the first step at or above it.
 */
function niceAxis(v: number): { max: number; ticks: number[] } {
  const peak = Math.max(v, 1);
  let step = 1;
  for (let p = 1; ; p *= 10) {
    const found = [1, 2, 5].map((m) => m * p).find((s) => 5 >= Math.ceil(peak / s));
    if (found) {
      step = found;
      break;
    }
  }
  const max = Math.max(step, Math.ceil(peak / step) * step);
  const ticks: number[] = [];
  for (let t = 0; t <= max; t += step) ticks.push(t);
  return { max, ticks };
}

export function compact(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** A rect with only its top corners rounded — the data end, never the baseline. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0 || w <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

export function BarChart(props: {
  title: string;
  labels: string[];
  /** Full label for the tooltip; defaults to `labels`. */
  tooltipLabels?: string[];
  series: Series[];
  stacked?: boolean;
  locale: string;
  format?: (n: number) => string;
}) {
  const { labels, series, stacked = false, locale } = props;
  const fmt = props.format ?? ((n: number) => new Intl.NumberFormat(locale).format(n));
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = labels.length;
  const totals = labels.map((_, i) =>
    stacked ? series.reduce((a, s) => a + (s.values[i] ?? 0), 0) : Math.max(0, ...series.map((s) => s.values[i] ?? 0)),
  );
  const { max, ticks } = niceAxis(Math.max(0, ...totals));
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / Math.max(n, 1);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 70))));

  const bars: Array<{ d: string; color: string; key: string }> = [];
  labels.forEach((_, i) => {
    const cx = PAD.left + band * i + band / 2;
    if (stacked) {
      const w = Math.min(24, band * 0.7);
      let base = 0;
      const nonZero = series.filter((s) => (s.values[i] ?? 0) > 0);
      nonZero.forEach((s, j) => {
        const v = s.values[i] ?? 0;
        const top = y(base + v);
        const bottom = y(base);
        // 2px surface gap above every segment except the topmost.
        const gap = j < nonZero.length - 1 ? 2 : 0;
        const h = bottom - top - gap;
        const isTop = j === nonZero.length - 1;
        bars.push({
          key: `${s.key}-${i}`,
          color: s.color,
          d: isTop ? topRounded(cx - w / 2, top, w, h, 4) : `M${cx - w / 2},${top + gap} h${w} v${Math.max(0, h)} h${-w} Z`,
        });
        base += v;
      });
    } else {
      const k = series.length;
      const w = Math.min(24, (band * 0.8 - 2 * (k - 1)) / k);
      const groupW = w * k + 2 * (k - 1);
      series.forEach((s, j) => {
        const v = s.values[i] ?? 0;
        const x = cx - groupW / 2 + j * (w + 2);
        bars.push({ key: `${s.key}-${i}`, color: s.color, d: topRounded(x, y(v), w, y(0) - y(v), 4) });
      });
    }
  });

  return (
    <figure className="chart">
      <figcaption className="chart__head">
        <span className="chart__title">{props.title}</span>
        {series.length > 1 && (
          <span className="chart__legend">
            {series.map((s) => (
              <span key={s.key} className="chart__key">
                <span className="chart__swatch" style={{ background: s.color }} aria-hidden="true" />
                {s.label}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <div ref={wrapRef} className="chart__plot" onMouseLeave={() => setHover(null)}>
        <svg width={width} height={HEIGHT} role="img" aria-label={props.title}>
          {ticks.map((tv) => (
            <g key={tv}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(tv)} y2={y(tv)} className="chart__grid" />
              <text x={PAD.left - 6} y={y(tv) + 4} textAnchor="end" className="chart__axis">
                {compact(tv, locale)}
              </text>
            </g>
          ))}
          {hover !== null && (
            <rect x={PAD.left + band * hover} y={PAD.top} width={band} height={plotH} className="chart__hoverband" />
          )}
          {bars.map((b) => (b.d ? <path key={b.key} d={b.d} fill={b.color} /> : null))}
          {labels.map((l, i) =>
            i % labelEvery === 0 ? (
              <text key={l} x={PAD.left + band * i + band / 2} y={HEIGHT - 6} textAnchor="middle" className="chart__axis">
                {l}
              </text>
            ) : null,
          )}
          {labels.map((l, i) => (
            <rect
              key={`hit-${l}`}
              x={PAD.left + band * i}
              y={PAD.top}
              width={band}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {hover !== null && (
          <div
            className="chart__tip"
            role="status"
            style={{ left: Math.min(width - 180, Math.max(0, PAD.left + band * hover + band / 2 - 90)) }}
          >
            <strong>{(props.tooltipLabels ?? labels)[hover]}</strong>
            {series.map((s) => (
              <span key={s.key} className="chart__tiprow">
                <span className="chart__swatch" style={{ background: s.color }} aria-hidden="true" />
                {s.label}
                <span className="num">{fmt(s.values[hover] ?? 0)}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
