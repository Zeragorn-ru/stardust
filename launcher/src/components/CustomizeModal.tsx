import { useState } from "react";
import SkinModal from "./SkinModal";

type Tab = "skin" | "nick";

interface Props {
  onClose: () => void;
}

export default function CustomizeModal({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>("skin");

  return (
    <div className="modal-overlay modal-overlay--no-blur" onClick={onClose}>
      <div
        className="modal customize-modal"
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
          <div className="customize-modal__body customize-wip">
            <span className="muted">В разработке</span>
          </div>
        )}
      </div>
    </div>
  );
}
