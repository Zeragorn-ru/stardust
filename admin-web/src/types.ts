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

// Настройки сервера (вкладка «Настройки»). Токен бота наружу не отдаётся —
// только флаг, привязан он или нет.
export interface Settings {
  telegramTokenSet: boolean;
  telegramBotUsername?: string;
  sftpHost?: string;
  sftpUsername?: string;
  sftpPasswordSet: boolean;
  sftpStatsPath?: string;
}

export interface PlayerStats {
  playtimeSeconds: number;
  lastLaunchedAt?: string;
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
  color: string;
}

export interface Gradient {
  id: number;
  label: string;
  colorStart: string;
  colorEnd: string;
}

export interface PlayerCustomization {
  availableBadges: Badge[];
  availableGradients: Gradient[];
  activeBadgeId: number | null;
  activeGradientId: number | null;
}
