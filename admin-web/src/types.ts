// Типы, общие для админки. Соответствуют DTO admin-server.

export interface BuildHeader {
  id: number;
  name: string;
  version: string;
  loaderKind: string;
  mcVersion: string;
  loaderVersion: string;
  isActive: boolean;
}

export interface BuildFile {
  id: number;
  path: string;
  sha1: string;
  sizeBytes: number;
  side: string;
  kind: string;
  overwrite: boolean;
  optional: boolean;
  enabledByDefault: boolean;
  disabled: boolean;
  modId: string | null;
  displayName: string | null;
  description: string | null;
  /** Профили, в которых состоит файл; пусто = «общий» (есть во всех). */
  profiles: string[];
}

/** Профиль опциональных модов сборки (пресет «Производительность»). */
export interface ModProfile {
  key: string;
  name: string;
  description: string | null;
  sortOrder: number;
}

export interface BuildDetail extends BuildHeader {
  files: BuildFile[];
  modProfiles: ModProfile[];
}

export interface Account {
  uuid: string;
  username: string;
  isAdmin: boolean;
  banned: boolean;
  bannedUntil?: string;
  banReason?: string;
  telegramLinked: boolean;
  telegramChatId?: string;
}

export type SkinModel = "classic" | "slim";

// Настройки сервера (вкладка «Настройки»). Токен бота наружу не отдаётся —
// только флаг, привязан он или нет.
export interface Settings {
  telegramTokenSet: boolean;
  telegramBotUsername?: string;
  sftpHost?: string;
  sftpUsername?: string;
  sftpPasswordSet: boolean;
  sftpStatsPath?: string;
  serverTelemetryTokenSet: boolean;
  backupEndpoint?: string;
  backupBucket?: string;
  backupRegion?: string;
  backupPrefix?: string;
  backupAccessKeySet: boolean;
  backupSecretKeySet: boolean;
  achievementCoinReward: number;
  /** Установлен ли GitHub-токен (секреты наружу не отдаём). */
  githubTokenSet?: boolean;
  /** Включён ли AI-анализ крашей. */
  crashAiEnabled?: boolean;
  /** Базовый URL OpenAI-совместимого провайдера. */
  crashAiEndpoint?: string;
  /** Имя модели AI. */
  crashAiModel?: string;
  /** Установлен ли AI-ключ (секреты наружу не отдаём). */
  crashAiApiKeySet?: boolean;
}

// ───── Сезоны и релизы лаунчера ─────

/** Сезон из GET /api/seasons (новые сверху). */
export interface Season {
  id: number;
  name: string;
  status: "active" | "archived";
  startedAt: string | null;
  endedAt: string | null;
  /** Число игроков в архивном снимке (только для завершённых сезонов). */
  accountsCount: number | null;
}

/** Статус фоновой задачи архивации сезона. */
export interface SeasonArchiveStatus {
  state: "idle" | "running" | "success" | "error";
  seasonId: number | null;
  seasonName: string | null;
  phase: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Релиз лаунчера из GitHub (GET /api/releases, теги «v…», новые сверху). */
export interface LauncherRelease {
  tag: string;
  name: string | null;
  prerelease: boolean;
  publishedAt: string | null;
}

/** Канал апдейтера: какой тег сейчас раздаёт (GET /api/launcher/channels). */
export interface LauncherChannel {
  /** `beta` | `stable`. */
  channel: string;
  /** Тег, который канал раздаёт, или null — канал ещё не настроен. */
  tag: string | null;
  /** RFC 3339 последнего обновления latest.json канала. */
  updatedAt: string | null;
}

/** Прогон сборки релиза в GitHub Actions (GET /api/releases/build-runs). */
export interface BuildRun {
  tag: string;
  /** `queued` | `running` | `success` | `failure` | `cancelled`. */
  state: string;
  runId: number;
  startedAt: string | null;
  legs: BuildLeg[];
}

/** Одна платформа-leg матрицы сборки. */
export interface BuildLeg {
  /** `windows` | `linux` | `macos`. */
  platform: string;
  state: string;
}

/** Статус фоновой задачи перевода релиза в стабильный. */
export interface PromoteStatus {
  state: "idle" | "running" | "success" | "error";
  tag: string | null;
  phase: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Статус фоновой задачи перестановки latest-тега канала. */
export interface SetLatestStatus {
  state: "idle" | "running" | "success" | "error";
  channel: string | null;
  tag: string | null;
  phase: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BackupStatus {
  state?: "idle" | "running" | "success" | "error" | string;
  status?: "idle" | "running" | "success" | "error" | string;
  message?: string | null;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastRunAt?: string | null;
  /** Ключ последнего загруженного объекта (data-…tar.gz). */
  lastObject?: string | null;
  /** Размер последнего архива в байтах. */
  lastSizeBytes?: number | null;
}

export interface PlayerStats {
  playtimeSeconds: number;
  lastJoinedAt?: string;
}

export interface CreateBuildInput {
  name: string;
  version: string;
  loaderKind: string;
  mcVersion: string;
  loaderVersion: string;
}

// Метаданные файла при загрузке (поле `meta` multipart).
export interface UploadMeta {
  path: string;
  side?: string;
  kind?: string;
  overwrite?: boolean;
  optional?: boolean;
  enabledByDefault?: boolean;
  disabled?: boolean;
  /** `null` = явно очистить поле на сервере; `undefined` = не менять. */
  modId?: string | null;
  displayName?: string | null;
  description?: string | null;
  /** Профили, в которых состоит файл; пусто/не задано — «общий». */
  profiles?: string[];
}

export interface BuildCheckProblem {
  path: string;
  sha1: string;
  kind: string;
  detail: string;
}

export interface BuildCheckResult {
  buildId: number;
  buildName: string;
  totalFiles: number;
  problems: BuildCheckProblem[];
}

export interface DepsCheckProblem {
  fromMod: string;
  requiredMod: string;
  versionRange: string;
  depType: string;
}

export interface DepsCheckResult {
  buildId: number;
  buildName: string;
  totalMods: number;
  problems: DepsCheckProblem[];
}

// Кастомизация ника
export interface Badge {
  id: number;
  emoji: string;
  label: string;
  description: string;
  color: string;
}

export interface Gradient {
  id: number;
  label: string;
  description: string;
  colorStart: string;
  colorEnd: string;
}

export interface PlayerCustomization {
  availableBadges: Badge[];
  availableGradients: Gradient[];
  activeBadgeId: number | null;
  activeGradientId: number | null;
  ownedBadgeIds?: number[];
  ownedGradientIds?: number[];
}

export interface NewsPost {
  id: number;
  title: string;
  markdown: string;
  authorName: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Guide {
  id: number;
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  markdown: string;
  authorName: string;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ServerTelemetrySample {
  recordedAt: string;
  onlineCount: number;
  players: string[];
  tps: number;
  mspt: number;
}

export interface ServerPlayerEvent {
  recordedAt: string;
  username: string;
  event: "join" | "quit";
}

export interface ServerTelemetry {
  samples: ServerTelemetrySample[];
  events: ServerPlayerEvent[];
  averageOnline: number;
}

export interface ServerLogSummary {
  id: number;
  recordedAt: string;
  eventType: "external_mods" | "join" | "quit" | "client_crash" | "server_crash" | string;
  username?: string;
  summary: string;
}

export interface ServerLogEntry {
  id: number;
  recordedAt: string;
  eventType: "external_mods" | "join" | "quit" | "client_crash" | "server_crash" | string;
  username?: string;
  summary: string;
  details: Record<string, unknown>;
  /** Статус AI-анализа краша: pending/done/failed или отсутствует. */
  aiStatus?: "pending" | "done" | "failed" | string;
  /** Вердикт AI (done) или {error} (failed). */
  aiAnalysis?: CrashAiAnalysis;
}

/** Вердикт AI-анализа краша (хранится в server_logs.ai_analysis). */
export interface CrashAiAnalysis {
  summary?: string;
  cause?: string;
  suggestion?: string;
  severity?: "low" | "medium" | "high" | "critical" | string;
  model?: string;
  analyzedAt?: string;
  /** Заполняется при aiStatus === "failed". */
  error?: string;
}

export interface ServerLogsResponse {
  logs: ServerLogSummary[];
  averageOnline: number;
}

export interface ExternalModAllowlistEntry {
  id: number;
  modId: string;
  jarName: string;
  sha256: string;
  createdAt: string;
}

export interface ExternalModBlockRule {
  id: number;
  sha256?: string;
  nameSubstring?: string;
  createdAt: string;
}
