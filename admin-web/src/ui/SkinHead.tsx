// Аватарка игрока: голова из его скина (передняя грань + слой шляпы),
// нарисованная на canvas с пиксельным масштабированием. Скин тянется
// с admin-server по uuid (bearer-токен). Если скина нет — показываем
// буквенный плейсхолдер с цветом, выведенным из uuid (стабильный per-player).
//
// PNG кэшируется API-клиентом и вызывается только в карточке игрока.

import { useEffect, useRef, useState } from "react";
import { api } from "../api";

// Передняя грань головы в текстуре 64×64: база [8,8,8,8], шляпа (2-й слой) [40,8,8,8].
const HEAD_BASE: [number, number, number, number] = [8, 8, 8, 8];
const HEAD_HAT: [number, number, number, number] = [40, 8, 8, 8];

/// Сбрасывает кэш скина игрока (после загрузки/импорта нового скина).
export function invalidateSkinCache(uuid: string): void {
  api.invalidateAccountSkin(uuid);
}

// Стабильный цвет фона плейсхолдера из uuid (HSL, приятная насыщенность).
function colorFromUuid(uuid: string): string {
  let hash = 0;
  for (let i = 0; i < uuid.length; i++) {
    hash = (hash * 31 + uuid.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsl(${hue} 42% 38%)`;
}

interface Props {
  uuid: string;
  username: string;
  /** Размер аватарки в экранных пикселях (квадрат). */
  size?: number;
}

export function SkinHead({ uuid, username, size = 32 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    setLoaded(false);
    setDataUrl(null);
    api.getAccountSkinUrl(uuid).then((url) => {
      if (!active) return;
      setDataUrl(url);
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [uuid]);

  useEffect(() => {
    if (!dataUrl) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const ratio = window.devicePixelRatio || 1;
    canvas.width = size * ratio;
    canvas.height = size * ratio;

    const img = new Image();
    img.onload = () => {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const [bx, by, bw, bh] = HEAD_BASE;
      ctx.drawImage(img, bx, by, bw, bh, 0, 0, canvas.width, canvas.height);
      const [hx, hy, hw, hh] = HEAD_HAT;
      ctx.drawImage(img, hx, hy, hw, hh, 0, 0, canvas.width, canvas.height);
    };
    img.src = dataUrl;
  }, [dataUrl, size]);

  // Пока грузим или скина нет — буквенный плейсхолдер.
  if (!dataUrl) {
    return (
      <span
        className={`skin-head placeholder${loaded ? "" : " loading"}`}
        style={{
          width: size,
          height: size,
          background: loaded ? colorFromUuid(uuid) : undefined,
        }}
        aria-hidden="true"
      >
        {loaded ? username.slice(0, 1).toUpperCase() : ""}
      </span>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className="skin-head"
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}
