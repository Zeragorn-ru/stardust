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

export default function CustomizeModal({ playerName, onClose, onNickSaved }: Props) {
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
    <div className="settings build-screen customize-screen" role="dialog" aria-modal="true" aria-label="Кастомизация">
      <Aurora />
      <header className="settings__header" data-tauri-drag-region="deep">
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          ← Назад
        </button>
        <h2>Кастомизация</h2>
        <div className="customize-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "skin"}
            className={"customize-tab" + (tab === "skin" ? " is-active" : "")}
            onClick={() => setTab("skin")}
          >
            Скин
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "nick"}
            className={"customize-tab" + (tab === "nick" ? " is-active" : "")}
            onClick={() => setTab("nick")}
          >
            Ник
          </button>
          <span
            className={"customize-tabs__ink" + (tab === "nick" ? " is-right" : "")}
            aria-hidden="true"
          />
        </div>
      </header>

      <div className="settings__layout">
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
