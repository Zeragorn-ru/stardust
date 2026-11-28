// Select — стилизованный нативный select. Нативный элемент сохраняет
// нативную клавиатуру/скринридеры; стилизуется только оболочка.

import type { ReactNode } from "react";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export interface SelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  label?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
}

export function Select<T extends string>({ value, onChange, options, label, ariaLabel, disabled }: SelectProps<T>) {
  const control = (
    <select
      className="kit-select-control"
      value={value}
      aria-label={typeof label === "string" ? undefined : ariaLabel}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );

  if (!label) return control;

  return (
    <label className="kit-select">
      <span className="kit-select-label">{label}</span>
      {control}
    </label>
  );
}
