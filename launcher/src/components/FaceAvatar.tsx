import { memo, useEffect, useRef } from "react";

interface Props {
  /** data-URL PNG скина, либо null — тогда рисуем плейсхолдер. */
  dataUrl: string | null;
  /** Размер аватарки в экранных пикселях (квадрат). */
  size?: number;
}

// Передняя грань головы в текстуре 64×64: база [8,8,8,8], шляпа (2-й слой) [40,8,8,8].
const HEAD_BASE: [number, number, number, number] = [8, 8, 8, 8];
const HEAD_HAT: [number, number, number, number] = [40, 8, 8, 8];

/**
 * Аватарка из лица скина: передняя грань головы + второй слой (шляпа),
 * с пиксельным (nearest) масштабированием.
 */
const FaceAvatar = memo(function FaceAvatar({ dataUrl, size = 64 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(size * dpr);
    canvas.width = px;
    canvas.height = px;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, px, px);

    if (!dataUrl) {
      drawPlaceholder(ctx, px);
      return;
    }

    const img = new Image();
    img.onload = () => {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, px, px);
      // База лица.
      const [bx, by, bw, bh] = HEAD_BASE;
      ctx.drawImage(img, bx, by, bw, bh, 0, 0, px, px);
      // Второй слой (шляпа/волосы) поверх.
      const [hx, hy, hw, hh] = HEAD_HAT;
      ctx.drawImage(img, hx, hy, hw, hh, 0, 0, px, px);
    };
    img.src = dataUrl;
  }, [dataUrl, size]);

  return <canvas ref={canvasRef} className="face-avatar" style={{ width: size, height: size }} />;
});

export default FaceAvatar;

function drawPlaceholder(ctx: CanvasRenderingContext2D, size: number) {
  const u = size / 8;

  // Background gradient — dark to slightly lighter
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, "#3a4060");
  grad.addColorStop(1, "#2a3050");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Head shape — rounded square
  ctx.fillStyle = "#5a6080";
  const pad = u * 0.5;
  const r = u * 0.6;
  const x = pad, y = pad, w = size - pad * 2, h = size - pad * 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();

  // Eyes — two squares with slight glow
  ctx.fillStyle = "#c8cce0";
  ctx.fillRect(u * 2, u * 3, u, u);
  ctx.fillRect(u * 5, u * 3, u, u);

  // Eye shine — small highlight
  ctx.fillStyle = "#e0e4f0";
  ctx.fillRect(u * 2, u * 3, u * 0.4, u * 0.4);
  ctx.fillRect(u * 5, u * 3, u * 0.4, u * 0.4);

  // Mouth — subtle line
  ctx.fillStyle = "#7a80a0";
  ctx.fillRect(u * 2.5, u * 5.5, u * 3, u * 0.5);
}
