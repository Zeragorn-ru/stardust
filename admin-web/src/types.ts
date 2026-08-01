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
}

export interface BuildDetail extends BuildHeader {
  files: BuildFile[];
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
  modId?: string;
  displayName?: string;
  description?: string;
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

export interface ServerLogEntry {
  id: number;
  recordedAt: string;
  eventType: "external_mods" | "join" | "quit" | "client_crash" | "server_crash" | string;
  username?: string;
  summary: string;
  details: Record<string, unknown>;
}

export interface ServerLogsResponse {
  logs: ServerLogEntry[];
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
