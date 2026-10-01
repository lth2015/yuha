import { useEffect, useRef, useState } from 'react';
import { subscribeBeat } from '../lib/beat';
import { startSheen } from '../lib/sheen';

/**
 * The light field: the coloured, slowly moving substrate every glass surface
 * in the app refracts. Without it the glass layer is a no-op — blurring a flat
 * canvas returns that same flat canvas, which is why the old light build read
 * as paper rather than material.
 *
 * Three wide lobes drift on transform only (never filter, never background-
 * position), so the whole field stays on the compositor. When audio plays the
 * field breathes with the real analyser from lib/beat; when nothing plays it
 * keeps a slow idle drift so the room is never dead.
 *
 * The grain on top is not decoration: wide gradients band visibly on 8-bit
 * displays and the grain dithers them. (It was written for a near-black
 * canvas, which is gone — the reason survives the theme, the explanation did
 * not, so this is the reason.)
 */
export function LightField() {
  const [energy, setEnergy] = useState(0);
  const [live, setLive] = useState(false);
  const raf = useRef(0);
  const shown = useRef(0);

  /*
   * Reduced motion is respected here, not only in CSS.
   *
   * The stylesheet pins the lobes with `scale: 1 !important`, so nothing
   * moves — but this component kept subscribing to the analyser and calling
   * `setEnergy` from a requestAnimationFrame loop, re-rendering itself about
   * sixty times a second for the whole length of every song, to animate a
   * value the page had been told to ignore. `Score.tsx` already reads the
   * same query with a live `change` listener; this had no check at all.
   */
  const [still, setStill] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setStill(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(
    () =>
      subscribeBeat((e, playing) => {
        if (still) {
          setLive(playing);
          return;
        }
        setLive(playing);
        // Ease towards the analyser value; raw frames make the lobes jitter.
        const step = () => {
          shown.current += (e - shown.current) * 0.12;
          setEnergy(shown.current);
          if (Math.abs(e - shown.current) > 0.004) raf.current = requestAnimationFrame(step);
        };
        cancelAnimationFrame(raf.current);
        raf.current = requestAnimationFrame(step);
      }),
    [still],
  );

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  useEffect(() => startSheen(), []);

  return (
    <div
      className={`lightfield${live ? ' is-live' : ''}`}
      style={{ '--energy': energy.toFixed(3) } as React.CSSProperties}
      aria-hidden="true"
    >
      <span className="lightfield__lobe lightfield__lobe--petal" />
      <span className="lightfield__lobe lightfield__lobe--violet" />
      <span className="lightfield__lobe lightfield__lobe--cyan" />
      <span className="lightfield__grain" />
    </div>
  );
}
