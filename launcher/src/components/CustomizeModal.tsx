import { useEffect, useRef, useState } from "react";
import Aurora from "./Aurora";
import SkinModal from "./SkinModal";
import NickCustomizer from "./NickCustomizer";

type Tab = "skin" | "nick";

interface Props {
  playerName: string;
  onClose: () => void;
  /** Профиль обновился (бейдж/градиент сохранены) — можно подтянуть свежие данные. */
  onNickSaved?: () => void;
  closing?: boolean;
}

export default function CustomizeModal({ playerName, onClose, onNickSaved, closing }: Props) {
  const [tab, setTab] = useState<Tab>("skin");
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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
            onClick={() => setTab("skin")}
          >
            Скин
          </button>
          <button
            type="button"
            className={
              "settings__nav-item" +
              (tab === "nick" ? " settings__nav-item--active" : "")
            }
            aria-current={tab === "nick" ? "true" : undefined}
            onClick={() => setTab("nick")}
          >
            Ник
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
