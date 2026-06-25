import { useEffect, useRef } from "react";

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
export default function FaceAvatar({ dataUrl, size = 64 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = size;
    canvas.height = size;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);

    if (!dataUrl) {
      drawPlaceholder(ctx, size);
      return;
    }

    const img = new Image();
    img.onload = () => {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, size, size);
      // База лица.
      const [bx, by, bw, bh] = HEAD_BASE;
      ctx.drawImage(img, bx, by, bw, bh, 0, 0, size, size);
      // Второй слой (шляпа/волосы) поверх.
      const [hx, hy, hw, hh] = HEAD_HAT;
      ctx.drawImage(img, hx, hy, hw, hh, 0, 0, size, size);
    };
    img.src = dataUrl;
  }, [dataUrl, size]);

  return <canvas ref={canvasRef} className="face-avatar" />;
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, size: number) {
  ctx.fillStyle = "#454b66";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#9aa0b5";
  const u = size / 8;
  ctx.fillRect(u * 2, u * 3, u, u);
  ctx.fillRect(u * 5, u * 3, u, u);
}
