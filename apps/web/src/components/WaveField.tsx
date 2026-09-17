import { useEffect, useRef } from 'react';

/**
 * WaveField — the hero's generative artwork: sound made visible.
 *
 * Layered flowing curves on canvas, drawn additive ("lighter") with a wide
 * soft pass and a thin bright core, like a calm spectrum landscape. When a
 * song plays anywhere in the app the field swells — the site literally
 * breathes with the music. No literal notes, no confetti: one idea.
 *
 * Honours prefers-reduced-motion (a single static frame is drawn) and pauses
 * when the tab is hidden.
 */
export function WaveField({ active = false, className }: { active?: boolean; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let raf = 0;
    let t = Math.random() * 100; // desynchronise multiple instances
    let intensity = 0.25;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const LAYERS = [
      { y: 0.60, amp: 0.050, freq: 1.35, drift: 0.55, hue: '212, 255, 98', alpha: 0.34, core: 0.85 },
      { y: 0.68, amp: 0.072, freq: 0.95, drift: -0.38, hue: '182, 160, 255', alpha: 0.30, core: 0.65 },
      { y: 0.54, amp: 0.034, freq: 2.10, drift: 0.80, hue: '240, 244, 250', alpha: 0.16, core: 0.55 },
      { y: 0.76, amp: 0.095, freq: 0.70, drift: -0.22, hue: '94, 75, 217', alpha: 0.26, core: 0.5 },
    ];

    const stroke = (layer: (typeof LAYERS)[number], w: number, h: number, pass: 'soft' | 'core') => {
      const grad = ctx!.createLinearGradient(0, 0, w, 0);
      const a = pass === 'soft' ? layer.alpha * 0.5 : layer.alpha;
      const rgb = layer.hue;
      grad.addColorStop(0, `rgba(${rgb}, 0)`);
      grad.addColorStop(0.18, `rgba(${rgb}, ${a * 0.7})`);
      grad.addColorStop(0.5, `rgba(${rgb}, ${a})`);
      grad.addColorStop(0.82, `rgba(${rgb}, ${a * 0.7})`);
      grad.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx!.strokeStyle = grad;
      ctx!.lineWidth = pass === 'soft' ? 6 * dpr : 1.1 * dpr;
      ctx!.globalAlpha = pass === 'soft' ? 0.6 : layer.core;
      ctx!.beginPath();
      const step = 5 * dpr;
      for (let x = 0; x <= w + step; x += step) {
        const px = x / w;
        // Slow envelope so the wave breathes rather than ticks.
        const envelope =
          0.55 +
          0.45 * Math.sin(t * 0.6 + px * 4.2 + layer.freq * 2) * Math.sin(t * 0.23 + px * 1.3);
        const y =
          h * layer.y +
          Math.sin(px * Math.PI * layer.freq * 2 + t * layer.drift * 2.1) *
            h *
            layer.amp *
            envelope *
            (0.8 + intensity * 0.9) +
          Math.sin(px * Math.PI * layer.freq * 5 - t * layer.drift) * h * layer.amp * 0.22 * intensity;
        if (x === 0) ctx!.moveTo(x, y);
        else ctx!.lineTo(x, y);
      }
      ctx!.stroke();
    };

    const frame = () => {
      const target = activeRef.current ? 1 : 0.22;
      intensity += (target - intensity) * 0.03;
      t += 0.011;
      const { width: w, height: h } = canvas;
      ctx!.clearRect(0, 0, w, h);
      ctx!.globalCompositeOperation = 'lighter';
      ctx!.lineCap = 'round';
      for (const layer of LAYERS) {
        stroke(layer, w, h, 'soft');
        stroke(layer, w, h, 'core');
      }
      ctx!.globalCompositeOperation = 'source-over';
      ctx!.globalAlpha = 1;
    };

    const loop = () => {
      if (!document.hidden) frame();
      raf = requestAnimationFrame(loop);
    };

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      intensity = 0.3;
      t = 7;
      frame();
    } else {
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className={`wave-field${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}
