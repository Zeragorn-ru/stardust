import { useState } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

/** Поле ввода пароля с кнопкой показать/скрыть. */
export default function PasswordInput({
  value,
  onChange,
  placeholder = "••••••••",
  disabled = false,
  autoFocus = false,
}: Props) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="password-field">
      <input
        className="input"
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
      />
      <button
        type="button"
        className="password-field__toggle"
        onClick={() => setVisible(!visible)}
        tabIndex={-1}
        aria-label={visible ? "Скрыть пароль" : "Показать пароль"}
      >
        {visible ? "●" : "○"}
      </button>
    </div>
  );
}
