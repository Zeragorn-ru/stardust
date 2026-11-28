// Chart — SVG-график онлайна с честной временной осью.
//
// Главный фикс OverviewView: там X позиция точки — индекс в массиве,
// поэтому пробелы в телеметрии сжимались и график врал. Здесь X всегда
// считается из timestamp в фиксированном окне (по умолчанию 24 ч);
// null-значения разрывают линию, а не рисуются нулями.

import { useEffect, useMemo, useRef, useState } from "react";
import { formatTelemetryTime } from "../../format";

export interface ChartPoint {
  /** Unix-время в миллисекундах. */
  t: number;
  /** null = нет данных в этот момент (разрыв линии, не ноль). */
  v: number | null;
}

export interface ChartProps {
  points: ChartPoint[];
  /** Ширина окна в часах (окно [конец − hours, конец]). */
  hours?: number;
  height?: number;
  unit?: string;
  ariaLabel: string;
}

const PAD = { top: 12, right: 12, bottom: 22, left: 36 };

/** «Круглый» максимум шкалы Y, не меньше 4. */
function niceMax(raw: number): number {
  const min = 4;
  const value = Math.max(min, raw);
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 2, 4, 5, 10]) {
    if (step * pow >= value) return step * pow;
  }
  return 10 * pow;
}

function formatTick(h: number): string {
  const date = new Date(h);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

interface Hover {
  x: number;
  y: number;
  cx: number;
  cy: number;
  t: number;
  v: number;
}

export function Chart({ points, hours = 24, height = 220, unit = "", ariaLabel }: ChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next) setWidth(Math.round(next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => {
    if (width <= 0) return null;
    const filled = points.filter((point) => point.v != null) as { t: number; v: number }[];
    const innerWidth = width - PAD.left - PAD.right;
    const innerHeight = height - PAD.top - PAD.bottom;
    const times = points.map((point) => point.t);
    const now = Date.now();
    const end = Math.max(now, ...times, 0);
    const start = end - hours * 3_600_000;
    const yMax = niceMax(Math.max(...filled.map((point) => point.v), 0) * 1.1);
    const x = (t: number) => PAD.left + ((t - start) / (end - start)) * innerWidth;
    const y = (v: number) => PAD.top + (1 - v / yMax) * innerHeight;

    // Отрезки линии: непрерывные прогоны ненулевых данных; null рвёт линию.
    const segments: { t: number; v: number }[][] = [];
    let current: { t: number; v: number }[] = [];
    for (const point of points) {
      if (point.v == null) {
        if (current.length > 0) segments.push(current);
        current = [];
      } else {
        current.push({ t: point.t, v: point.v });
      }
    }
    if (current.length > 0) segments.push(current);

    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
      v: yMax * fraction,
      y: y(yMax * fraction),
    }));
    const xTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
      const t = start + fraction * (end - start);
      return { t, x: x(t), label: formatTick(t) };
    });

    return { start, end, yMax, x, y, segments, yTicks, xTicks, filled };
  }, [points, width, height, hours]);

  function onMove(event: React.MouseEvent<HTMLDivElement>) {
    if (!geometry) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const t = geometry.start + ((px - PAD.left) / (width - PAD.left - PAD.right)) * (geometry.end - geometry.start);
    let best: Hover | null = null;
    let bestDistance = Infinity;
    for (const point of geometry.filled) {
      const distance = Math.abs(point.t - t);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = {
          x: px,
          y: event.clientY - rect.top,
          cx: geometry.x(point.t),
          cy: geometry.y(point.v),
          t: point.t,
          v: point.v,
        };
      }
    }
    setHover(best);
  }

  return (
    <div
      className="kit-chart"
      ref={wrapRef}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      role="img"
      aria-label={ariaLabel}
    >
      {geometry && geometry.filled.length > 0 ? (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <g className="kit-chart-grid">
            {geometry.yTicks.map((tick) => (
              <g key={tick.v}>
                <line x1={PAD.left} x2={width - PAD.right} y1={tick.y} y2={tick.y} />
                <text x={PAD.left - 6} y={tick.y + 3} textAnchor="end">
                  {Math.round(tick.v)}
                </text>
              </g>
            ))}
            {geometry.xTicks.map((tick) => (
              <text key={tick.t} x={tick.x} y={height - 6} textAnchor="middle">
                {tick.label}
              </text>
            ))}
          </g>
          {geometry.segments.map((segment, index) => {
            if (segment.length === 1) {
              const point = segment[0];
              return <circle key={index} className="kit-chart-cursor" cx={geometry.x(point.t)} cy={geometry.y(point.v)} r={2.5} />;
            }
            const line = segment
              .map((point) => `${geometry.x(point.t).toFixed(1)},${geometry.y(point.v).toFixed(1)}`)
              .join(" ");
            const first = segment[0];
            const last = segment[segment.length - 1];
            const baseline = geometry.y(0);
            const area = `M ${geometry.x(first.t).toFixed(1)},${baseline} L ${line.replace(/ /g, " L ")} L ${geometry
              .x(last.t)
              .toFixed(1)},${baseline} Z`;
            return (
              <g key={index}>
                <path className="kit-chart-area" d={area} />
                <polyline className="kit-chart-line" points={line} />
              </g>
            );
          })}
          {hover && <circle className="kit-chart-cursor" cx={hover.cx} cy={hover.cy} r={4} />}
        </svg>
      ) : (
        <div className="kit-chart-empty">Нет данных телеметрии за окно</div>
      )}
      {hover && (
        <div className="kit-chart-tooltip" style={{ left: hover.cx, top: hover.cy - 8 }}>
          <span className="kit-chart-tooltip-value">
            {hover.v}
            {unit}
          </span>{" "}
          <span className="kit-chart-tooltip-time">{formatTelemetryTime(new Date(hover.t).toISOString())}</span>
        </div>
      )}
    </div>
  );
}
