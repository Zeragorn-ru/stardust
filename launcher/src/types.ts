// Типы, разделяемые между UI и Rust-бэкендом лаунчера.
// Зеркалят структуры из crate `protocol` и Tauri-команд.

export interface PlayerProfile {
  /** UUID без дефисов (формат Mojang). */
  id: string;
  /** Имя игрока. */
  name: string;
}

/** Расширенные сведения об аккаунте владельца (вкладка «Аккаунт»). */
export interface AccountInfo {
  profile: PlayerProfile;
  /** Привязан ли Telegram для 2FA. */
  telegramLinked: boolean;
  /** Имеет ли аккаунт права администратора. */
  isAdmin: boolean;
}

export interface Settings {
  /** Выделяемая память JVM, МБ. */
  memoryMb: number;
}

/** Режим запуска лаунчера. */
export type LaunchMode = "portable" | "installed";

/** Сведения о среде запуска (read-only, для экрана настроек). */
export interface AppInfo {
  mode: LaunchMode;
  /** Абсолютный путь к папке, где лежит exe. */
  exeDir: string;
  /** Найден ли рядом с exe portable.txt/.portable. */
  portableMarker: boolean;
  /** Абсолютный путь к папке данных лаунчера. */
  dataDir: string;
  /** Версия лаунчера. */
  version: string;
}

/** Модель скина: classic (4px руки) или slim (3px руки). */
export type SkinModel = "classic" | "slim";

/** Скин игрока. */
export interface Skin {
  /** data-URL PNG, либо null если скин не задан. */
  dataUrl: string | null;
  model: SkinModel;
  /** data-URL PNG плаща, либо null если плащ не задан. */
  capeUrl: string | null;
  /** UUID лицензии-источника, если скин синхронизируется с Mojang. */
  source?: string | null;
}

/** Результат проверки обновлений лаунчера. */
export interface UpdateInfo {
  /** Доступна ли новая версия. */
  available: boolean;
  /** Текущая версия лаунчера. */
  currentVersion: string;
  /** Версия обновления, если доступно. */
  version: string | null;
  /** Заметки к релизу, если есть. */
  notes: string | null;
}

/** Опциональный мод активной сборки (вкладка «Сборка»). */
export interface OptionalMod {
  /** Стабильный идентификатор (modId из манифеста). */
  modId: string;
  /** Человекочитаемое имя. */
  name: string;
  /** Короткое описание, либо null. */
  description: string | null;
  /** Включён ли мод у текущего игрока. */
  enabled: boolean;
  /** Размер файла в байтах. */
  size: number;
}

/** Этап работы лаунчера, влияет на отображаемый экран/состояние. */
export type LauncherPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "extracting"
  | "launching"
  | "running"
  | "error";

/** Прогресс обновления/запуска, приходит событиями из бэкенда. */
export interface Progress {
  phase: LauncherPhase;
  /** Человекочитаемое описание текущего шага. */
  label: string;
  /** 0..1; null — неопределённый прогресс. */
  fraction: number | null;
  /** Сколько байт уже готово в рамках текущего шага. */
  downloadedBytes?: number | null;
  /** Общий размер текущего шага, если известен. */
  totalBytes?: number | null;
  /** Скорость скачивания, байт/сек. */
  speedBytesPerSec?: number | null;
  /** Оставшееся время, секунд. */
  etaSeconds?: number | null;
}
