export type Accent = "violet" | "gold";

const STORAGE_KEY = "launcher-accent";

export function normalizeAccent(value: string | null | undefined): Accent {
  return value === "gold" ? "gold" : "violet";
}

/** Ставит data-accent на <html>. Возвращает нормализованное значение. */
export function applyAccent(value: string | null | undefined): Accent {
  const accent = normalizeAccent(value);
  document.documentElement.dataset.accent = accent;
  return accent;
}

/** Акцент из localStorage — читается синхронно до первого рендера, без вспышки. */
export function storedAccent(): Accent {
  try {
    return normalizeAccent(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "violet";
  }
}

export function rememberAccent(accent: Accent): void {
  try {
    localStorage.setItem(STORAGE_KEY, accent);
  } catch {
    /* приватный режим — не критично */
  }
}
