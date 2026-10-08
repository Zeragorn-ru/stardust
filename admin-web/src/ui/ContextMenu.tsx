// Контекстное меню (правый клик) — глобальный сервис в стиле useToast/useConfirm.
//
// const menu = useContextMenu();
// onContextMenu={(e) => menu.open(e, { items: [...] })}
//
// Меню открывается в точке клика (со сдвигом внутрь окна, чтобы не вылезло
// за край), закрывается по клику вне / Escape / прокрутке / ресайзе / Tab.
// Поддерживает иконку и подсказку у пункта, опасные пункты, разделители
// и субтитр-заголовок (напр. имя файла). Полностью клавиатурно-доступно:
// пункт — <button>, Escape закрывает, фокус уходит на первый пункт.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface ContextMenuItem {
  /** Текст пункта. */
  label: string;
  /** Клик по пункту. Асинхронность — на стороне вызывающего (toast и т.д.). */
  onSelect: () => void;
  /** Иконка слева (опционально). */
  icon?: ReactNode;
  /** Опасное действие — красный текст. */
  danger?: boolean;
  /** Пункт неактивен. */
  disabled?: boolean;
  /** Показывать справа (напр. «Ctrl+C»). */
  hint?: string;
}

/** Пункт меню или разделитель («-»). */
export type ContextMenuEntry = ContextMenuItem | "-";

interface ContextMenuSpec {
  items: ContextMenuEntry[];
  /** Заголовок-субтитр над пунктами (напр. имя файла). */
  title?: string;
  x: number;
  y: number;
}

export type ContextMenuOpenFn = (
  e: { clientX: number; clientY: number; preventDefault(): void },
  spec: Omit<ContextMenuSpec, "x" | "y">,
) => void;

const MenuCtx = createContext<ContextMenuOpenFn | null>(null);

export function useContextMenu(): ContextMenuOpenFn {
  const ctx = useContext(MenuCtx);
  if (!ctx) throw new Error("useContextMenu вне ContextMenuProvider");
  return ctx;
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<ContextMenuSpec | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const open = useCallback<ContextMenuOpenFn>((e, spec) => {
    e.preventDefault();
    setMenu({ ...spec, x: e.clientX, y: e.clientY });
  }, []);

  const close = useCallback(() => setMenu(null), []);

  // Позиционирование: сдвигаем меню, если оно вылезает за край окна.
  useEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - rect.width - 8);
    const y = Math.min(menu.y, window.innerHeight - rect.height - 8);
    if (x !== menu.x || y !== menu.y) {
      setMenu((m) => (m ? { ...m, x: Math.max(8, x), y: Math.max(8, y) } : m));
    }
  }, [menu]);

  // Закрытие по клику вне, Escape, прокрутке и ресайзу.
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    // capture: перехватываем раньше глобальных Escape-хендлеров модалок.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu, close]);

  const api = useMemo(() => open, [open]);

  return (
    <MenuCtx.Provider value={api}>
      {children}
      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          role="menu"
          aria-label={menu.title ?? "Контекстное меню"}
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {menu.title && <div className="context-menu__title">{menu.title}</div>}
          {menu.items.map((item, i) =>
            item === "-" ? (
              <div key={`sep-${i}`} className="context-menu__sep" role="separator" />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`context-menu__item${item.danger ? " danger" : ""}`}
                disabled={item.disabled}
                autoFocus={i === 0}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
              >
                {item.icon && <span className="context-menu__icon">{item.icon}</span>}
                <span className="context-menu__label">{item.label}</span>
                {item.hint && <span className="context-menu__hint muted">{item.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </MenuCtx.Provider>
  );
}
