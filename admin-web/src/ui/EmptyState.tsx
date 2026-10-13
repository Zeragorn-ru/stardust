// Канонические пустые состояния экранов: загрузка / пусто / ошибка / устарело.
//
// Паттерн портирован из LogsView: ошибка и пустой список — разные вещи,
// и сбой загрузки не должен выглядеть как «всё хорошо, просто данных нет».
//   - LoadPanel    — идёт первая загрузка, данных ещё нет;
//   - EmptyPanel   — загрузка прошла успешно, данных нет («создайте первую…»);
//   - ErrorPanel   — данных нет И загрузка упала, с кнопкой «Повторить»;
//   - StaleBanner  — фоновый сбой при непустом списке: показываем причину,
//                    не убирая уже загруженные данные.

import type { ComponentProps, ReactNode } from "react";

interface RetryProps {
  /** Текст кнопки; по умолчанию «Повторить». */
  retryText?: string;
  /** Колбэк кнопки. Кнопка не рендерится без него. */
  onRetry?: () => void;
  /** Блокировка на время повторной загрузки. */
  busy?: boolean;
}

function RetryButton({ retryText, onRetry, busy }: RetryProps) {
  if (!onRetry) return null;
  return (
    <button className="secondary" type="button" onClick={onRetry} disabled={busy}>
      {retryText ?? "Повторить"}
    </button>
  );
}

/** Первая загрузка: спиннер вместо списка, чтобы экран не мигал пустым. */
export function LoadPanel({ children, ...rest }: ComponentProps<"section">) {
  return (
    <section className="panel panel-flat empty-state-panel" {...rest}>
      <p className="muted">
        <span className="spinner" /> {children ?? "Загрузка…"}
      </p>
    </section>
  );
}

/** Данных нет после успешной загрузки: приглашение к первому действию. */
export function EmptyPanel({
  title,
  children,
  action,
  ...rest
}: ComponentProps<"section"> & { title: ReactNode; action?: ReactNode }) {
  return (
    <section className="panel panel-flat empty-state-panel" {...rest}>
      <strong>{title}</strong>
      {children && <p className="muted">{children}</p>}
      {action}
    </section>
  );
}

/** Загрузка упала и данных нет: причина + «Повторить». */
export function ErrorPanel({
  title,
  children,
  retryText,
  onRetry,
  busy,
  ...rest
}: ComponentProps<"section"> & RetryProps & { title: ReactNode }) {
  return (
    <section className="panel panel-flat empty-state-panel" role="alert" {...rest}>
      <strong>{title}</strong>
      {children && <p className="muted">{children}</p>}
      <RetryButton retryText={retryText} onRetry={onRetry} busy={busy} />
    </section>
  );
}

/**
 * Фоновое обновление не удалось, но данные на экране есть: причина
 * и «Повторить» лентой над списком (порт паттерна .logs-stale).
 */
export function StaleBanner({
  children,
  retryText,
  onRetry,
  busy,
  ...rest
}: ComponentProps<"div"> & RetryProps) {
  return (
    <div className="logs-stale" role="alert" {...rest}>
      <strong>Не удалось обновить данные</strong>
      <span className="muted">{children}</span>
      <RetryButton retryText={retryText} onRetry={onRetry} busy={busy} />
    </div>
  );
}
