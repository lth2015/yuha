/**
 * Dancing equalizer bars — the app's "this is playing" signal.
 *
 * CSS-driven with per-bar staggered durations; `live` only animates while a
 * song is actually playing, and the whole thing freezes to a static set of
 * bars under prefers-reduced-motion (global override in styles.css).
 */
export function Eq({ live = false, large = false, className }: { live?: boolean; large?: boolean; className?: string }) {
  return (
    <span
      className={`eq${live ? ' is-live' : ''}${large ? ' eq--lg' : ''}${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    >
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
