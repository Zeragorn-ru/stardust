/** macOS (Tauri app или Safari/WebKit в dev). */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

/** Модификатор «команда» на macOS, Ctrl на остальных. */
export function isModKey(event: KeyboardEvent): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}
