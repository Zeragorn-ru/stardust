/** Внешний вид лаунчера: тема и акцентный цвет. */

export type ThemeName = "classic" | "amoled";
export type AccentName = "violet" | "gold" | "custom";

interface Appearance {
  theme: ThemeName;
  accent: AccentName;
  /** Hex-цвет кастомного акцента (#RRGGBB); нужен только при accent = custom. */
  customHex: string;
}

const STORAGE_KEY = "launcher-appearance";

const DEFAULT_APPEARANCE: Appearance = {
  theme: "classic",
  accent: "violet",
  customHex: "#7c5cff",
};

export function normalizeTheme(value: string | null | undefined): ThemeName {
  return value === "amoled" ? "amoled" : "classic";
}

export function normalizeAccent(value: string | null | undefined): AccentName {
  return value === "gold" || value === "custom" ? value : "violet";
}

/** Строгий парсинг hex: только #RRGGBB (или RRGGBB без решётки). */
export function normalizeCustomHex(value: string | null | undefined): string {
  const raw = (value ?? "").trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(raw) ? `#${raw.toLowerCase()}` : "";
}

/** #RRGGBB → «r, g, b» для rgba(var(--accent-rgb), …). */
export function hexToRgb(hex: string): string {
  const raw = normalizeCustomHex(hex).replace(/^#/, "");
  if (!raw) return "201, 184, 255";
  return `${parseInt(raw.slice(0, 2), 16)}, ${parseInt(raw.slice(2, 4), 16)}, ${parseInt(
    raw.slice(4, 6),
    16,
  )}`;
}

/** Линейная относительная яркость (WCAG, 0..1) — чтобы выбрать цвет текста на акценте. */
function luminance(hex: string): number {
  const raw = normalizeCustomHex(hex).replace(/^#/, "");
  if (!raw) return 1;
  const lin = (i: number) => {
    const c = parseInt(raw.slice(i, i + 2), 16) / 255;
    // Дельта-E по глазу нелинейна: линеаризуем компонент перед взвешиванием.
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  // Компоненты идут через байт: индексы 0, 2, 4, а не подряд.
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
}

const hexPair = (hex: string): [number, number, number] => {
  const raw = normalizeCustomHex(hex).replace(/^#/, "") || "7c5cff";
  return [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16)) as [number, number, number];
};

const rgbToHex = (r: number, g: number, b: number): string =>
  "#" + [r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("");

/**
 * Цвет текста на акценте. Порог по линейной яркости: ярко-зелёный/оранжевый/
 * золотой дают тёмный текст, тёмно-фиолетовый/синий — светлый. Вместо чистых
 * чёрного и белого — оттененные варианты: тёмный сохраняет тон акцента,
 * светлый лишь слегка подкрашен им.
 */
function textOnAccent(hex: string): string {
  const [r, g, b] = hexPair(hex);
  return luminance(hex) > 0.4
    ? rgbToHex(r * 0.15, g * 0.15, b * 0.15)
    : rgbToHex(255 * 0.88 + r * 0.12, 255 * 0.88 + g * 0.12, 255 * 0.88 + b * 0.12);
}

/**
 * Ставит акцентные переменные инлайном на <html>. Пресеты (violet/gold)
 * управляются CSS через data-accent — инлайн-переменные сбрасываются.
 * Кастомный цвет перекрывает любую тему инлайном.
 */
export function applyAccent(name: AccentName, customHex?: string): void {
  const root = document.documentElement;
  const style = root.style;
  const hex = normalizeCustomHex(customHex);
  if (name === "custom" && hex) {
    root.dataset.accent = "custom";
    style.setProperty("--accent", hex);
    // Сплошной цвет без градиента: оба стопа одинаковые, --accent-2 = hex,
    // иначе элементы с accent-2/accent-grad выглядят двуцветными.
    style.setProperty("--accent-2", hex);
    style.setProperty("--accent-grad", `linear-gradient(135deg, ${hex} 0%, ${hex} 100%)`);
    style.setProperty("--accent-rgb", hexToRgb(hex));
    // Текст на акценте — оттененный, не чисто чёрный/белый.
    style.setProperty("--text-on-gold", textOnAccent(hex));
    // Ползунки и прочие элементы красятся через --gold/--gold-hover —
    // при custom их CSS не переопределяет, ставим инлайном.
    style.setProperty("--gold", hex);
    style.setProperty("--gold-hover", hex);
  } else {
    root.dataset.accent = name === "gold" ? "gold" : "violet";
    [
      "--accent",
      "--accent-2",
      "--accent-grad",
      "--accent-rgb",
      "--text-on-gold",
      "--gold",
      "--gold-hover",
    ].forEach((v) => style.removeProperty(v));
  }
}

/** Тема: data-theme на <html>; classic — атрибут снимается (дефолт в CSS). */
export function applyTheme(name: ThemeName): void {
  const root = document.documentElement;
  if (name === "amoled") {
    root.dataset.theme = "amoled";
  } else {
    delete root.dataset.theme;
  }
}

/** Применяет весь внешний вид разом (тема + акцент). */
export function applyAppearance(view: {
  theme?: string;
  accent?: string;
  customAccent?: string | null;
}): void {
  applyTheme(normalizeTheme(view.theme));
  applyAccent(normalizeAccent(view.accent), normalizeCustomHex(view.customAccent));
}

function readStored(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    return {
      theme: normalizeTheme(parsed.theme),
      accent: normalizeAccent(parsed.accent),
      customHex: normalizeCustomHex(parsed.customHex) || DEFAULT_APPEARANCE.customHex,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

/** Внешний вид из localStorage — читается синхронно до первого рендера. */
export function storedAppearance(): Appearance {
  return readStored();
}

/**
 * Запоминает внешний вид. Поля с undefined не трогают сохранённое значение;
 * при уходе с custom hex сохраняется (чтобы вернуться без повторного выбора).
 */
export function rememberAppearance(view: {
  theme?: string;
  accent?: string;
  customAccent?: string | null;
}): void {
  const current = readStored();
  const next: Appearance = {
    theme: normalizeTheme(view.theme ?? current.theme),
    accent: normalizeAccent(view.accent ?? current.accent),
    customHex: normalizeCustomHex(view.customAccent) || current.customHex,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* приватный режим — не критично */
  }
}
