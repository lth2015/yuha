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
 * The grain on top is not decoration: wide gradients across a near-black
 * canvas band badly on 8-bit displays, and banding is the single clearest
 * tell of a cheap dark interface.
 */
export function LightField() {
  const [energy, setEnergy] = useState(0);
  const [live, setLive] = useState(false);
  const raf = useRef(0);
  const shown = useRef(0);

  useEffect(
    () =>
      subscribeBeat((e, playing) => {
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
    [],
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
