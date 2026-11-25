// Примитивы админки: единый набор контролов, из которых собран каждый экран.
// Правило (см. REDESIGN.md): у экранов своего CSS нет — только эти компоненты
// и классы из primitives.css. Одинаковые отступы/высоты/радиусы по построению.

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { useBodyScrollLock } from "./useBodyScrollLock";
import { useDialogFocus } from "./useDialogFocus";
import { IconClose, IconCopy, IconSearch } from "./icons";

// ───────────────────────── Button ─────────────────────────

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "danger"
  | "ghost";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  /** Идёт запрос: спиннер вместо иконки, клик заблокирован. */
  busy?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  busy,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={`btn btn-${variant} btn-${size}${className ? ` ${className}` : ""}`}
      disabled={disabled || busy}
    >
      {busy ? <span className="spinner" /> : icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Доступное имя: единственный текст кнопки — aria-label. */
  label: string;
  size?: "md" | "sm";
  busy?: boolean;
}

export function IconButton({
  label,
  size = "md",
  busy,
  children,
  className,
  disabled,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      className={`iconbtn iconbtn-${size}${className ? ` ${className}` : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
    >
      {busy ? <span className="spinner" /> : children}
    </button>
  );
}

// ───────────────────────── Inputs ─────────────────────────

export function Input({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={`input${className ? ` ${className}` : ""}`} />;
}

export function Textarea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...rest}
      className={`textarea${className ? ` ${className}` : ""}`}
    />
  );
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={`select${className ? ` ${className}` : ""}`}>
      {children}
    </select>
  );
}

/** Поисковое поле с иконкой и кнопкой очистки. */
export function SearchInput({
  value,
  onValueChange,
  placeholder = "Поиск…",
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <div className={`search-input${className ? ` ${className}` : ""}`}>
      <IconSearch size={15} />
      <input
        {...rest}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onValueChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          className="iconbtn iconbtn-sm"
          aria-label="Очистить"
          onClick={() => onValueChange("")}
        >
          <IconClose size={13} />
        </button>
      )}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`switch${disabled ? " switch-disabled" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch-track" aria-hidden="true" />
      {label && <span>{label}</span>}
    </label>
  );
}

/** Checkbox строгого вида (без кастомизации — только акцентная рамка). */
export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
}) {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span aria-hidden="true" />
      {label && <span>{label}</span>}
    </label>
  );
}

// ───────────────────────── Field ─────────────────────────

interface FieldProps {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  /** Поле на всю ширину строки в grid-форме. */
  wide?: boolean;
}

export function Field({ label, hint, error, children, wide }: FieldProps) {
  return (
    <label className={`field${wide ? " field-wide" : ""}`}>
      <span className="field-label">{label}</span>
      {children}
      {error ? (
        <span className="field-error">{error}</span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </label>
  );
}

/** Сеточная форма: два столбца, Field с wide — на всю строку. */
export function Form({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`form${className ? ` ${className}` : ""}`}>{children}</div>;
}

/** Строка формы с действиями (справа). */
export function FormActions({ children }: { children: ReactNode }) {
  return <div className="form-actions">{children}</div>;
}

// ───────────────────────── Panel ─────────────────────────

interface PanelProps {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** Плотный внутренний отступ (для таблиц). */
  flush?: boolean;
  className?: string;
}

export function Panel({
  title,
  description,
  actions,
  children,
  flush,
  className,
}: PanelProps) {
  return (
    <section className={`panel${flush ? " panel-flush" : ""}${className ? ` ${className}` : ""}`}>
      {(title || actions) && (
        <header className="panel-head">
          <div className="grow">
            {title && <h2 className="panel-title">{title}</h2>}
            {description && <p className="panel-desc">{description}</p>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

// ───────────────────────── Table ─────────────────────────

interface TableProps {
  columns: { key: string; label: ReactNode; width?: string; align?: "left" | "right" | "center" }[];
  rows: { key: string; cells: Record<string, ReactNode>; className?: string; clickable?: boolean; onClick?: () => void }[];
  /** Текст/узел при нуле строк (обычно EmptyState). */
  empty?: ReactNode;
}

/** Строгая таблица: фикс-высота строки, sticky header, ellipsis в ячейках. */
export function Table({ columns, rows, empty }: TableProps) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                style={{ width: col.width, textAlign: col.align ?? "left" }}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.key}
              className={`${row.className ?? ""}${row.clickable ? " clickable" : ""}`}
              onClick={row.onClick}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  style={{ textAlign: col.align ?? "left" }}
                >
                  {row.cells[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Ячейка с переполнением под ellipsis и tooltip. */
export function EllipsisCell({ text, mono }: { text: string; mono?: boolean }) {
  return (
    <span className={`ellipsis${mono ? " mono" : ""}`} title={text}>
      {text}
    </span>
  );
}

// ───────────────────────── Tabs ─────────────────────────

interface TabsProps<T extends string> {
  tabs: { key: T; label: string }[];
  active: T;
  onSelect: (key: T) => void;
}

export function Tabs<T extends string>({ tabs, active, onSelect }: TabsProps<T>) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={tab.key === active}
          className={`tab${tab.key === active ? " tab-active" : ""}`}
          onClick={() => onSelect(tab.key)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

// ───────────────────────── Modal ─────────────────────────

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Ширина: md — формы, lg — редакторы/таблицы. */
  size?: "md" | "lg";
  footer?: ReactNode;
}

export function Modal({ title, onClose, children, size = "md", footer }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  useBodyScrollLock();
  useDialogFocus(ref, onClose);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={ref}
        className={`modal modal-${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <IconButton label="Закрыть" size="sm" onClick={onClose}>
            <IconClose size={15} />
          </IconButton>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

// ───────────────────────── Chips / Badges ─────────────────────────

export type ChipTone = "neutral" | "accent" | "ok" | "err" | "warn" | "info";

export function Chip({
  tone = "neutral",
  children,
  title,
}: {
  tone?: ChipTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {children}
    </span>
  );
}

// ───────────────────────── StatTile ─────────────────────────

export function StatTile({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  tone?: ChipTone;
}) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className={`stat-value${tone ? ` text-${tone}` : ""}`}>{value}</span>
      {detail && <span className="stat-detail">{detail}</span>}
    </div>
  );
}

// ───────────────────────── Empty / Error / Stale ─────────────────────────

interface EmptyStateProps {
  title: string;
  body?: string;
  action?: ReactNode;
}

export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      {body && <p className="muted">{body}</p>}
      {action && <div>{action}</div>}
    </div>
  );
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-panel" role="alert">
      <span>Не удалось загрузить данные: {message}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Повторить
        </Button>
      )}
    </div>
  );
}

/** Полоска «данные показаны, но фоновое обновление не удалось». */
export function StaleBanner({ message }: { message: string }) {
  return (
    <div className="stale-banner" role="status">
      Данные могут быть неактуальны: {message}
    </div>
  );
}

/** Состояние первого экрана: loading → error → данные. */
export function PageState({
  loading,
  error,
  onRetry,
  children,
}: {
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div className="page-state">
        <span className="spinner spinner-lg" />
        Загрузка…
      </div>
    );
  }
  if (error) return <ErrorPanel message={error} onRetry={onRetry} />;
  return <>{children}</>;
}

// ───────────────────────── Toolbar / PageHeader ─────────────────────────

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

export function PageHeader({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <h1>{title}</h1>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}

// ───────────────────────── ProgressBar ─────────────────────────

export function ProgressBar({
  value,
  tone,
}: {
  /** 0..1. */
  value: number;
  tone?: ChipTone;
}) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div
      className={`progress${tone ? ` progress-${tone}` : ""}`}
      role="progressbar"
      aria-valuenow={Math.round(pct * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span style={{ width: `${pct * 100}%` }} />
    </div>
  );
}

// ───────────────────────── CopyButton ─────────────────────────

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      label={copied ? "Скопировано" : (label ?? "Копировать")}
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // Копирование недоступно (небезопасный контекст) — молча.
        }
      }}
    >
      <IconCopy size={14} />
    </IconButton>
  );
}

// ───────────────────────── ContextMenu ─────────────────────────

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onSelect: () => void;
}

const MenuCtx = createContext<(e: React.MouseEvent, items: MenuItem[]) => void>(
  () => {},
);

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Закрытие по клику вне меню и по Escape.
  useEffect(() => {
    if (!menu) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenu(null);
    }
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  function open(e: React.MouseEvent, items: MenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    // Не даём меню вылезти за окно: сдвигаем у края.
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY, window.innerHeight - items.length * 36 - 16);
    setMenu({ x, y, items });
  }

  return (
    <MenuCtx.Provider value={open}>
      {children}
      {menu && (
        <div
          ref={ref}
          className="context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          {menu.items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`context-menu-item${item.danger ? " context-menu-danger" : ""}`}
              onClick={() => {
                setMenu(null);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </MenuCtx.Provider>
  );
}

/** Хук открытия контекстного меню (onContextMenu={openMenu}). */
export function useContextMenu(): (e: React.MouseEvent, items: MenuItem[]) => void {
  return useContext(MenuCtx);
}
