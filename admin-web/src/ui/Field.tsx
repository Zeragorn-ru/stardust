// Поля форм: единая ассоциация label ↔ input и единый вывод ошибок.
//
// Закрывает три конвенции, которые раньше были раскиданы по формам:
// htmlFor на label без id на input, label-обёртка без ассоциации и
// поля вообще без label. Field гарантирует пару htmlFor/id, а FieldError
// — id для aria-describedby, чтобы скринридер зачитывал ошибку поля.

import { useId, type ComponentProps, type ReactNode } from "react";

/** Render-проп Field: контрол получает ассоциацию (id/aria) из обёртки. */
export type FieldChildren = ReactNode | ((control: FieldControl) => ReactNode);

export interface FieldProps extends Omit<ComponentProps<"div">, "children"> {
  /** Текст подписи; если не задан — поле без видимого label (aria-only). */
  label?: ReactNode;
  /** Подсказка/описание под подписью, зачитывается как описание поля. */
  hint?: ReactNode;
  /** Текст ошибки: включает aria-invalid и aria-describedby у поля. */
  error?: ReactNode;
  /**
   * id поля. По умолчанию генерируется автоматически (useId); передавайте
   * свой, только если на поле нужно ссылаться извне.
   */
  inputId?: string;
  /** Содержимое: один input/select/textarea или render-проп с ассоциацией. */
  children: FieldChildren;
}

/**
 * Обёртка поля с гарантированной ассоциацией label ↔ control.
 *
 * Контрол внутри получает контекст ассоциации через render-проп
 * (см. FieldInput ниже) — обычные <input> достаточно передать
 * третьим аргументом вместе с `fieldProps(id, invalid, describedBy)`.
 */
export function Field({
  label,
  hint,
  error,
  inputId,
  children,
  className,
  ...rest
}: FieldProps) {
  const autoId = useId();
  const id = inputId ?? autoId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  // Несколько описаний: hint и error читаются вместе.
  const describedBy =
    [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className={`field${className ? ` ${className}` : ""}`} {...rest}>
      {label !== undefined && (
        <label htmlFor={id}>{label}</label>
      )}
      {hint !== undefined && (
        <p className="field-hint muted" id={hintId}>
          {hint}
        </p>
      )}
      {typeof children === "function"
        ? (children as (control: FieldControl) => ReactNode)({
            id,
            invalid: Boolean(error),
            describedBy,
          })
        : children}
      {error !== undefined && error !== null && error !== "" && (
        <FieldError id={errorId}>{error}</FieldError>
      )}
    </div>
  );
}

/** Пропсы, которые Field пробрасывает в контрол через render-проп. */
export interface FieldControl {
  id: string;
  invalid: boolean;
  describedBy?: string;
}

/**
 * Вывод ошибки поля с id. Ставится под контролом; Field подключает её
 * автоматически, но отдельно полезно для кастомных раскладок.
 *
 * aria-invalid/aria-describedby вешаются на сам контрол.
 */
export function FieldError({
  id,
  children,
  ...rest
}: ComponentProps<"p">) {
  return (
    <p className="field-error" id={id} role="alert" {...rest}>
      {children}
    </p>
  );
}

/**
 * Готовый input с проводкой ассоциации: подставляет id,
 * aria-invalid и aria-describedby из Field.
 */
export function FieldInput({
  control,
  ...props
}: ComponentProps<"input"> & { control?: FieldControl }) {
  return (
    <input
      id={control?.id}
      aria-invalid={control?.invalid || undefined}
      aria-describedby={control?.describedBy}
      {...props}
    />
  );
}

/**
 * Состояние «touched + ошибка» — паттерн мягкой валидации из
 * CreateBuildForm: подсказка показывается только после выхода из
 * поля (blur), а не сразу при открытии формы.
 */
export function fieldTouchedError(
  touched: boolean,
  error: string | null | undefined,
): string | undefined {
  return touched && error ? error : undefined;
}
