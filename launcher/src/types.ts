// Типы, разделяемые между UI и Rust-бэкендом лаунчера.
// Зеркалят структуры из crate `protocol` и Tauri-команд.

export interface PlayerProfile {
  /** UUID без дефисов (формат Mojang). */
  id: string;
  /** Имя игрока. */
  name: string;
  /** Активный бейдж (эмодзи-префикс), если выбран. */
  activeBadge?: { id: number; emoji: string; color: string } | null;
  /** Активный градиент (раскраска ника), если выбран. */
  activeGradient?: { id: number; colorStart: string; colorEnd: string } | null;
}

/** Бейдж для выбора. */
export interface Badge {
  id: number;
  emoji: string;
  label: string;
  color: string;
}

/** Градиент для выбора. */
export interface Gradient {
  id: number;
  label: string;
  colorStart: string;
  colorEnd: string;
}

/** Информация о кастомизации игрока. */
export interface PlayerCustomization {
  availableBadges: Badge[];
  availableGradients: Gradient[];
  activeBadgeId: number | null;
  activeGradientId: number | null;
}

/** Расширенные сведения об аккаунте владельца (вкладка «Аккаунт»). */
export interface AccountInfo {
  profile: PlayerProfile;
  /** Привязан ли Telegram для 2FA. */
  telegramLinked: boolean;
  /** Имеет ли аккаунт права администратора. */
  isAdmin: boolean;
}

/** Результат входа: либо сессия (профиль), либо требование второго фактора. */
export type LoginOutcome =
  | { status: "ok"; profile: PlayerProfile }
  | {
      status: "twoFactorRequired";
      challenge: string;
      hint?: string;
      /** Подтверждение кнопкой в Telegram: опрашивать статус вместо ввода кода. */
      buttonApproval: boolean;
    };

/** Результат опроса кнопочного подтверждения (вход без пароля / 2FA / сброс).
 *
 * Для сценариев входа `approved` несёт профиль (сессия уже сохранена в
 * бэкенде). Для сброса пароля `approved` приходит без профиля — нужно показать
 * форму нового пароля и вызвать `passwordResetConfirm`. */
export type ChallengeOutcome =
  | { status: "pending" }
  | { status: "approved"; profile?: PlayerProfile }
  | { status: "denied" }
  | { status: "expired" };

/** Ответ на запрос кода привязки Telegram. */
export interface TelegramLinkResponse {
  /** Код для команды `/start <code>` боту. */
  code: string;
  /** Username бота (без `@`), если известен. */
  botUsername?: string;
  /** Готовая deep-link `https://t.me/<bot>?start=<code>`, если известен бот. */
  deepLink?: string;
}

export interface Settings {
  /** Выделяемая память JVM, МБ. */
  memoryMb: number;
  /** Сколько файлов качать одновременно (библиотеки, ассеты, моды). */
  downloadConcurrency: number;
  /** Показывать 3D-модель скина на главном экране. */
  show3dModel: boolean;
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

/** Прогресс обновления лаунчера (отдельно от прогресса запуска игры). */
export interface UpdateProgress {
  /** Фаза: "downloading_bootstrap" | "downloading_installer" | "verifying_sha256" | "launching" | "error". */
  phase: string;
  /** Описание для отображения. */
  label: string;
  /** Общий прогресс 0..1. */
  fraction: number | null;
  /** Сколько байт скачано. */
  downloadedBytes: number | null;
  /** Общий размер файла. */
  totalBytes: number | null;
  /** Скорость загрузки (байт/сек). */
  speedBytesPerSec: number | null;
  /** Оставшееся время (секунды). */
  etaSeconds: number | null;
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

/** Статистика игрока. */
export interface PlayerStats {
  /** Суммарное время игры, секунды. */
  playtimeSeconds: number;
  /** ISO-8601 дата последнего запуска, либо null. */
  lastLaunchedAt: string | null;
}
