// UI-преференсы лаунчера (хранятся локально в браузере/webview).
//
// Это чисто клиентские настройки внешнего вида, поэтому держим их в
// localStorage, а не в бэкенде: их нужно применять синхронно до первого
// рендера, чтобы не было «мигания» анимаций.

const ANIM_KEY = "launcher.animations";
const ONBOARDED_KEY = "launcher.onboarded";

/** Просит ли система уменьшить количество анимаций. */
export function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

/** Включены ли анимации. По умолчанию — да, если система не против. */
export function getAnimations(): boolean {
  const raw = localStorage.getItem(ANIM_KEY);
  if (raw === null) return !prefersReducedMotion();
  return raw === "1";
}

/** Сохранить выбор и сразу применить его к документу. */
export function setAnimations(on: boolean): void {
  localStorage.setItem(ANIM_KEY, on ? "1" : "0");
  applyMotion(on);
}

/** Прошёл ли пользователь первичную настройку. */
export function isOnboarded(): boolean {
  return localStorage.getItem(ONBOARDED_KEY) === "1";
}

/** Отметить онбординг пройденным. */
export function setOnboarded(): void {
  localStorage.setItem(ONBOARDED_KEY, "1");
}

/** Проставить режим движения на корне документа (CSS гейтит по нему анимации). */
export function applyMotion(on: boolean): void {
    document.documentElement.dataset.motion = on ? "on" : "off";
}

/** Включены ли анимации прямо сейчас (читает data-motion из DOM). */
export function animationsEnabled(): boolean {
    return document.documentElement.dataset.motion !== "off";
}

// Применяем сразу при импорте модуля — до первого рендера React,
// чтобы исключить вспышку анимаций на старте.
applyMotion(getAnimations());
