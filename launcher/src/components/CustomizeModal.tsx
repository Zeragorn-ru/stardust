import { useEffect, useRef, useState } from "react";
import Aurora from "./Aurora";
import SkinModal from "./SkinModal";
import NickCustomizer from "./NickCustomizer";
import { markNewTabViewed, unviewedNewTabs } from "../whatsNew";

type Tab = "skin" | "nick";

interface Props {
  playerName: string;
  onClose: () => void;
  /** Профиль обновился (бейдж/градиент сохранены) — можно подтянуть свежие данные. */
  onNickSaved?: () => void;
  closing?: boolean;
  /** Вкладка с новинками открыта — главный экран гасит свой кружок. */
  onNewTabViewed?: () => void;
}

export default function CustomizeModal({ playerName, onClose, onNickSaved, closing, onNewTabViewed }: Props) {
  const [tab, setTab] = useState<Tab>("skin");
  // Непросмотренные вкладки с новинками (whatsNew): на них горит кружок.
  const [newTabs, setNewTabs] = useState<string[]>(() => unviewedNewTabs());
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onNewTabViewedRef = useRef(onNewTabViewed);
  onNewTabViewedRef.current = onNewTabViewed;

  // Начальная вкладка "skin" открыта сразу — считаем её просмотренной.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (newTabs.includes("skin")) openTab("skin");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Открытие вкладки = просмотр: закрываем её кружок. Вызывается и на
  // монтировании — начальная вкладка "skin" тоже считается открытой.
  const openTab = (next: Tab) => {
    setTab(next);
    if (!newTabs.includes(next)) return;
    markNewTabViewed(next);
    setNewTabs((prev) => prev.filter((t) => t !== next));
    onNewTabViewedRef.current?.();
  };

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      className={
        "settings build-screen customize-screen" +
        (closing ? " build-screen--closing" : "")
      }
      role="dialog"
      aria-modal="true"
      aria-label="Кастомизация"
    >
      <Aurora />
      <header className="settings__header" data-tauri-drag-region="deep">
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          ← Назад
        </button>
        <h2>Кастомизация</h2>
      </header>

      <div className="settings__layout">
        {/* Подвкладки слева — та же боковая навигация, что в настройках
            и на экране сборки. */}
        <nav className="settings__nav" aria-label="Разделы кастомизации">
          <button
            type="button"
            className={
              "settings__nav-item" +
              (tab === "skin" ? " settings__nav-item--active" : "")
            }
            aria-current={tab === "skin" ? "true" : undefined}
            onClick={() => openTab("skin")}
          >
            Скин
            {newTabs.includes("skin") && <span className="settings__nav-new-dot" aria-label="Есть новинки" />}
          </button>
          <button
            type="button"
            className={
              "settings__nav-item" +
              (tab === "nick" ? " settings__nav-item--active" : "")
            }
            aria-current={tab === "nick" ? "true" : undefined}
            onClick={() => openTab("nick")}
          >
            Ник
            {newTabs.includes("nick") && <span className="settings__nav-new-dot" aria-label="Есть новинки" />}
          </button>
        </nav>

        <div className="settings__body customize-screen__body">
          {tab === "skin" ? (
            <SkinModal embedded onClose={onClose} />
          ) : (
            <NickCustomizer playerName={playerName} onSaved={onNickSaved} />
          )}
        </div>
      </div>
    </div>
  );
}
