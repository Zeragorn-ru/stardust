import { useEffect, useRef, useState } from "react";
import SkinModal from "./SkinModal";
import NickCustomizer from "./NickCustomizer";

type Tab = "skin" | "nick";

interface Props {
  playerName: string;
  onClose: () => void;
  closing?: boolean;
}

export default function CustomizeModal({ playerName, onClose, closing }: Props) {
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
    <div className={"modal-overlay" + (closing ? " modal-overlay--closing" : "")} onClick={onClose}>
      <div
        className={"modal customize-modal" + (closing ? " modal--closing" : "")}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal__header customize-modal__header">
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
          <button
            type="button"
            className="btn btn--icon"
            onClick={onClose}
            aria-label="Закрыть"
          >
            ✕
          </button>
        </header>

        {tab === "skin" ? (
          <div className="customize-modal__body">
            <SkinModal embedded onClose={onClose} />
          </div>
        ) : (
          <div className="customize-modal__body">
            <NickCustomizer playerName={playerName} />
          </div>
        )}
      </div>
    </div>
  );
}
