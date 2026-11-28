// SidePicker — единый контрол стороны мода: клиент / сервер / оба.
// Обёртка над Segmented: раньше сторона мода рисовалась то списком, то
// тумблером — теперь один контрол на все экраны.
//
// allowAll добавляет опцию «все»: для фильтров («любая сторона») и
// массовых операций («у выделенных разные стороны»). Значение "all" —
// не сторона мода, а «не выбрано/неважно», поэтому apply-логика на месте
// вызова обязана игнорировать его.

import { Segmented } from "./Segmented";

export type ModSide = "client" | "server" | "both";
export type SideValue = ModSide | "all";

const SIDE_OPTIONS: { value: ModSide; label: string; hint: string }[] = [
  { value: "client", label: "Клиент", hint: "Только в сборке игрока" },
  { value: "server", label: "Сервер", hint: "Только на сервере" },
  { value: "both", label: "Оба", hint: "И клиент, и сервер" },
];

const ALL_OPTION = { value: "all" as const, label: "Все", hint: "Любая сторона" };

export interface SidePickerProps<T extends SideValue = ModSide> {
  value: T;
  onChange: (value: T) => void;
  /** Подпись слева; опустите, если контекст очевиден. */
  label?: string;
  disabled?: boolean;
  /** Добавить опцию «Все» (фильтры, смешанное выделение). */
  allowAll?: boolean;
}

export function SidePicker<T extends SideValue = ModSide>({
  value,
  onChange,
  label,
  disabled,
  allowAll,
}: SidePickerProps<T>) {
  // Опции типизируем приведением: состав зависит от allowAll, а T —
  // от вызывающей стороны (ModSide без «все», SideValue с ней).
  const options = (
    allowAll ? [ALL_OPTION, ...SIDE_OPTIONS] : SIDE_OPTIONS
  ) as { value: T; label: string; hint: string }[];

  return (
    <span className="kit-side-picker">
      {label && <span className="kit-side-picker-label">{label}</span>}
      <Segmented options={options} value={value} onChange={onChange} ariaLabel="Сторона мода" disabled={disabled} />
    </span>
  );
}
