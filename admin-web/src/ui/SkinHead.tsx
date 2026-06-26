// Аватарка игрока: голова из его скина (передняя грань + слой шляпы),
// нарисованная на canvas с пиксельным масштабированием. Скин тянется
// с admin-server по uuid (bearer-токен). Если скина нет — показываем
// буквенный плейсхолдер с цветом, выведенным из uuid (стабильный per-player).
//
// PNG кэшируется по uuid на уровне модуля: таблица аккаунтов перерисовывается
// часто (поиск, действия), а скин у игрока меняется редко.

import { useEffect, useRef, useState } from "react";
import { api } from "../api";

// Передняя грань головы в текстуре 64×64: база [8,8,8,8], шляпа (2-й слой) [40,8,8,8].
const HEAD_BASE: [number, number, number, number] = [8, 8, 8, 8];
const HEAD_HAT: [number, number, number, number] = [40, 8, 8, 8];

// Кэш загруженных скинов: uuid -> object URL | null (нет скина) | Promise (в полёте).
const skinCache = new Map<string, string | null | Promise<string | null>>();

async function loadSkinUrl(uuid: string): Promise<string | null> {
  const cached = skinCache.get(uuid);
  if (cached !== undefined) return cached;
  const promise = api
    .getAccountSkinUrl(uuid)
    .then((url) => {
      skinCache.set(uuid, url);
      return url;
    })
    .catch(() => {
      skinCache.set(uuid, null);
      return null;
    });
  skinCache.set(uuid, promise);
  return promise;
}

/// Сбрасывает кэш скина игрока (после загрузки/импорта нового скина).
export function invalidateSkinCache(uuid: string): void {
  const cached = skinCache.get(uuid);
  if (typeof cached === "string") URL.revokeObjectURL(cached);
  skinCache.delete(uuid);
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
    loadSkinUrl(uuid).then((url) => {
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
