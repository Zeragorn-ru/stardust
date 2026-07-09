import { memo, useEffect, useMemo, useRef } from "react";
import { animationsEnabled } from "../preferences";

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function generateDriftKeyframes(seed: string) {
  const id = `drift-${seed}`;
  const frames: string[] = [];

  for (let i = 0; i <= 3; i++) {
    const t = i / 3;
    const tx = rand(-8, 8);
    const ty = rand(-7, 7);
    const sc = rand(0.85, 1.2);
    frames.push(
      `${Math.round(t * 100)}% { transform: translate(${tx.toFixed(1)}vmax, ${ty.toFixed(1)}vmax) scale(${sc.toFixed(2)}); }`
    );
  }

  return `@keyframes ${id} { ${frames.join(" ")} }`;
}

const BLOB_COLORS = [
  { bg: "#7c5cff", pos: "top: -18%; left: -10%", size: "50vmax" },
  { bg: "#4f8cff", pos: "bottom: -22%; right: -12%", size: "50vmax" },
  { bg: "#18b8a6", pos: "top: 30%; left: 40%", size: "38vmax" },
];

const Aurora = memo(function Aurora() {
  const anim = animationsEnabled();
  const styleRef = useRef<HTMLStyleElement | null>(null);

  const seeds = useMemo(() => ["a", "b", "c"].map(() => Math.random().toString(36).slice(2, 8)), []);

  useEffect(() => {
    if (!anim) {
      if (styleRef.current) {
        styleRef.current.remove();
        styleRef.current = null;
      }
      return;
    }

    const sheet = document.createElement("style");
    sheet.textContent = seeds.map(generateDriftKeyframes).join("\n");
    document.head.appendChild(sheet);
    styleRef.current = sheet;

    return () => {
      sheet.remove();
      styleRef.current = null;
    };
  }, [anim, seeds]);

  return (
    <div className="aurora" aria-hidden="true">
      {BLOB_COLORS.map((blob, i) => (
        <span
          key={i}
          className="aurora__blob"
          style={{
            background: `radial-gradient(circle, ${blob.bg} 0%, transparent 65%)`,
            [blob.pos.includes("top") ? "top" : "bottom"]: blob.pos.includes("top")
              ? blob.pos.match(/top:\s*([^;]+)/)![1]
              : blob.pos.match(/bottom:\s*([^;]+)/)![1],
            [blob.pos.includes("left") ? "left" : "right"]: blob.pos.includes("left")
              ? blob.pos.match(/left:\s*([^;]+)/)![1]
              : blob.pos.match(/right:\s*([^;]+)/)![1],
            width: blob.size,
            height: blob.size,
            animation: anim ? `drift-${seeds[i]} ${20 + i * 4}s ease-in-out infinite alternate` : "none",
          }}
        />
      ))}
      <div className="aurora__grain" />
    </div>
  );
});

export default Aurora;
