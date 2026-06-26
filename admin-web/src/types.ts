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
  modId?: string;
  displayName?: string;
  description?: string;
}
