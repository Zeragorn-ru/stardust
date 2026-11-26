// «Что нового» в кастомизации: кружок-индикатор новых фич на вкладках.
//
// Механика: список NEW_FEATURES объявляет версию, в которой появились
// фичи, и вкладки кастомизации, где их смотреть. Отметки просмотра живут
// в localStorage: после релиза у всех кружок горит (отметок на новую
// версию ещё нет), каждая открытая вкладка с новинками закрывает свой
// кружок, а когда просмотрены все — гаснет индикатор и на кнопке
// «Кастомизация» главного экрана.

const STORAGE_KEY = "whats-new-seen-v1";

interface SeenState {
  version: string;
  /** Вкладки, которые пользователь уже открывал в этой версии. */
  viewed: string[];
}

/** Новинки текущего релиза: обновлять при добавлении фич в кастомизацию. */
const NEW_FEATURES = {
  version: "1.0.41",
  tabs: ["skin", "nick"],
} as const;

function readSeen(): SeenState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SeenState;
    if (typeof parsed?.version !== "string" || !Array.isArray(parsed?.viewed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSeen(state: SeenState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Приватный режим/переполнение — индикация просто не сохранится.
  }
}

/** Версия, для которой сейчас показываются новинки. */
export function whatsNewVersion(): string {
  return NEW_FEATURES.version;
}

/** Вкладки кастомизации с непросмотренными новинками этой версии. */
export function unviewedNewTabs(): string[] {
  const seen = readSeen();
  if (!seen || seen.version !== NEW_FEATURES.version) {
    return [...NEW_FEATURES.tabs];
  }
  return NEW_FEATURES.tabs.filter((tab) => !seen.viewed.includes(tab));
}

/** Есть ли непросмотренные новинки вообще (для кружка на кнопке). */
export function hasUnviewedNew(): boolean {
  return unviewedNewTabs().length > 0;
}

/** Отмечает вкладку просмотренной (после открытия вкладки в модалке). */
export function markNewTabViewed(tab: string) {
  const current = unviewedNewTabs();
  if (!current.includes(tab)) return;
  const seen: SeenState = {
    version: NEW_FEATURES.version,
    viewed: [
      ...(readSeen()?.version === NEW_FEATURES.version ? readSeen()!.viewed : []),
      tab,
    ],
  };
  writeSeen(seen);
}
