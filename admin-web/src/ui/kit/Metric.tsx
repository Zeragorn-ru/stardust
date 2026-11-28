// Metric — крупное число с подписью и состоянием ok/warn/bad.
// Цвета — из токенов; цифры — моноширинные с tabular-nums, чтобы
// разряды не плясали при обновлении значений.

import type { ReactNode } from "react";

export type MetricState = "ok" | "warn" | "bad" | "neutral";

export interface MetricProps {
  value: ReactNode;
  label: ReactNode;
  state?: MetricState;
  hint?: ReactNode;
  /** Увеличенный кегль для главной метрики дашборда. */
  hero?: boolean;
}

export function Metric({ value, label, state = "neutral", hint, hero }: MetricProps) {
  const stateClass = state === "neutral" ? "" : ` kit-metric--${state}`;
  return (
    <div className={`kit-metric${stateClass}${hero ? " kit-metric--hero" : ""}`}>
      <span className="kit-metric-value">{value}</span>
      <span className="kit-metric-label">{label}</span>
      {hint != null && <span className="kit-metric-hint">{hint}</span>}
    </div>
  );
}
