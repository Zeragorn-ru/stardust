// Toggle — булев переключатель kit (admin-v2).
//
// Доступность: настоящий <button role="switch"> — фокус, Space/Enter и
// aria-checked работают из коробки, без ручных обработчиков клавиш.

import type { ReactNode } from "react";

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** Скрытая подпись для скринридеров, если label не рендерится. */
  ariaLabel?: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, ariaLabel, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className="kit-toggle"
      onClick={() => onChange(!checked)}
    >
      <span className="kit-toggle-track" aria-hidden="true">
        <span className="kit-toggle-thumb" />
      </span>
      {label}
    </button>
  );
}
