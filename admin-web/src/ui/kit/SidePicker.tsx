// SidePicker — единый контрол стороны мода: клиент / сервер / оба.
// Обёртка над Segmented: раньше сторона мода рисовалась то списком, то
// тумблером — теперь один контрол на все экраны.

import { Segmented } from "./Segmented";

export type ModSide = "client" | "server" | "both";

const SIDE_OPTIONS: { value: ModSide; label: string; hint: string }[] = [
  { value: "client", label: "Клиент", hint: "Только в сборке игрока" },
  { value: "server", label: "Сервер", hint: "Только на сервере" },
  { value: "both", label: "Оба", hint: "И клиент, и сервер" },
];

export interface SidePickerProps {
  value: ModSide;
  onChange: (value: ModSide) => void;
  /** Подпись слева; опустите, если контекст очевиден. */
  label?: string;
  disabled?: boolean;
}

export function SidePicker({ value, onChange, label, disabled }: SidePickerProps) {
  return (
    <span className="kit-side-picker">
      {label && <span className="kit-side-picker-label">{label}</span>}
      <Segmented options={SIDE_OPTIONS} value={value} onChange={onChange} ariaLabel="Сторона мода" disabled={disabled} />
    </span>
  );
}
