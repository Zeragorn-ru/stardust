// Segmented — сегментный контрол из 2–4 взаимоисключающих опций.
//
// Доступность: role="radiogroup" + role="radio" с roving tabindex;
// стрелки перемещают выбор, как у нативных radio-кнопок.

import { useRef } from "react";
import type { KeyboardEvent } from "react";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Короткое пояснение (title), если имя опции самоцитирующее. */
  hint?: string;
}

export interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}

export function Segmented<T extends string>({ options, value, onChange, ariaLabel, disabled }: SegmentedProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null);

  function select(next: T) {
    if (!disabled && next !== value) onChange(next);
  }

  function move(offset: number) {
    const index = options.findIndex((option) => option.value === value);
    if (index < 0) return;
    const next = options[(index + offset + options.length) % options.length];
    select(next.value);
    // Фокус следует за выбором (roving tabindex).
    const group = groupRef.current;
    if (group) {
      const buttons = group.querySelectorAll<HTMLButtonElement>("[role='radio']");
      buttons.forEach((button) => (button.tabIndex = button.dataset.value === next.value ? 0 : -1));
      buttons.forEach((button) => {
        if (button.dataset.value === next.value) button.focus();
      });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      default:
        break;
    }
  }

  return (
    <div className="kit-segmented" role="radiogroup" aria-label={ariaLabel} ref={groupRef} onKeyDown={onKeyDown}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-value={option.value}
            tabIndex={selected ? 0 : -1}
            title={option.hint}
            disabled={disabled}
            className="kit-segmented-option"
            onClick={() => select(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
