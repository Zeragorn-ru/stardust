import { closeWindow, maximizeWindow, minimizeWindow, startWindowDrag } from "../api";

export default function TitleBar() {
  return (
    <div
      className="titlebar"
      data-tauri-drag-region
      onMouseDown={startWindowDrag}
    >
      <div className="titlebar__brand" data-tauri-drag-region>
        <span className="titlebar__mark" data-tauri-drag-region />
        <span data-tauri-drag-region>StarDust Launcher</span>
      </div>
      <div className="titlebar__actions">
        <button
          type="button"
          className="window-btn"
          aria-label="Свернуть"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={minimizeWindow}
        >
          <span />
        </button>
        <button
          type="button"
          className="window-btn"
          aria-label="Развернуть"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={maximizeWindow}
        >
          <span className="window-btn__maximize" />
        </button>
        <button
          type="button"
          className="window-btn window-btn--close"
          aria-label="Закрыть"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={closeWindow}
        >
          ×
        </button>
      </div>
    </div>
  );
}
