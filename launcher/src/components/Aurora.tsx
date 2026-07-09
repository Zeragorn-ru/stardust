import { memo, useEffect, useMemo, useRef } from "react";
import { animationsEnabled } from "../preferences";

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

// Зоны движения каждого блоба (в vmax, viewport ≈ 100×100).
// Зоны расположены так, чтобы50vmax-блобы не пересекались:
//   1 — верхний левый, 2 — верхний правый, 3 — нижний центр.
// Расстояние между центрами любых двух зон > 50vmax.
const ZONES = [
  { xMin: -20, xMax: 10, yMin: -18, yMax: 15 },
  { xMin: 40, xMax: 70, yMin: -18, yMax: 15 },
  { xMin: 8, xMax: 42, yMin: 38, yMax: 68 },
];

const BLOB_CONFIG = [
  { color: "#7c5cff", size: "50vmax", opacity: 0.5, dur: 22 },
  { color: "#4f8cff", size: "50vmax", opacity: 0.5, dur: 26 },
  { color: "#18b8a6", size: "38vmax", opacity: 0.38, dur: 30 },
];

// Фиксированные позиции когда анимации выключены.
const FIXED_POS = [
  { top: "-18%", left: "-10%" },
  { top: "-22%", right: "-12%" },
  { top: "30%", left: "40%" },
];

function generateDriftKeyframes(seed: string, zone: (typeof ZONES)[0]) {
  const id = `drift-${seed}`;
  const steps = 5;
  const frames: string[] = [];

  for (let i = 0; i <= steps; i++) {
    const pct = Math.round((i / steps) * 100);
    const x = rand(zone.xMin, zone.xMax);
    const y = rand(zone.yMin, zone.yMax);
    frames.push(`${pct}% { left: ${x.toFixed(1)}vmax; top: ${y.toFixed(1)}vmax; }`);
  }

  return `@keyframes ${id} { ${frames.join(" ")} }`;
}

const Aurora = memo(function Aurora() {
  const anim = animationsEnabled();
  const styleRef = useRef<HTMLStyleElement | null>(null);

  const seeds = useMemo(
    () => ["a", "b", "c"].map(() => Math.random().toString(36).slice(2, 8)),
    [],
  );

  useEffect(() => {
    if (!anim) {
      styleRef.current?.remove();
      styleRef.current = null;
      return;
    }

    const sheet = document.createElement("style");
    sheet.textContent = seeds
      .map((s, i) => generateDriftKeyframes(s, ZONES[i]))
      .join("\n");
    document.head.appendChild(sheet);
    styleRef.current = sheet;

    return () => {
      sheet.remove();
      styleRef.current = null;
    };
  }, [anim, seeds]);

  return (
    <div className="aurora" aria-hidden="true">
      {BLOB_CONFIG.map((blob, i) => (
        <span
          key={i}
          className="aurora__blob"
          style={{
            background: `radial-gradient(circle, ${blob.color} 0%, transparent 65%)`,
            width: blob.size,
            height: blob.size,
            opacity: blob.opacity,
            ...(anim ? {} : FIXED_POS[i]),
            animation: anim
              ? `drift-${seeds[i]} ${blob.dur}s ease-in-out infinite alternate`
              : "none",
          }}
        />
      ))}
      <div className="aurora__grain" />
    </div>
  );
});

export default Aurora;
