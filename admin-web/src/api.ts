// HTTP-клиент админки. Токен админа храним в localStorage и шлём как Bearer.
//
// Базовый префикс пустой: в dev запросы идут на относительные пути и
// проксируются Vite на admin-server; в проде статику и API раздаёт один хост.

import type {
  Account,
  Badge,
  BuildCheckResult,
  BuildDetail,
  BuildFile,
  BuildHeader,
  CreateBuildInput,
  DepsCheckResult,
  Gradient,
  PlayerCustomization,
  PlayerStats,
  Settings,
  UploadMeta,
} from "./types";
import { baseName } from "./format";

const TOKEN_KEY = "admin_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

/// Ошибка с человекочитаемым сообщением от сервера.
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const resp = await fetch(path, { method, headers, body: payload });
  if (resp.status === 204) return undefined as T;

  const text = await resp.text();
  const data = text ? safeJson(text) : undefined;
  if (!resp.ok) {
    const message =
      (data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : null) ?? `Ошибка ${resp.status}`;
    throw new ApiError(resp.status, message);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface LoginResult {
  token: string;
  username: string;
  uuid: string;
}

export const api = {
  async login(username: string, password: string): Promise<LoginResult> {
    const res = await request<LoginResult>("POST", "/api/login", {
      username,
      password,
    });
    setToken(res.token);
    return res;
  },

  async logout(): Promise<void> {
    try {
      await request<void>("POST", "/api/logout");
    } finally {
      setToken(null);
    }
  },

  me(): Promise<{ username: string; uuid: string }> {
    return request("GET", "/api/me");
  },

  listBuilds(): Promise<BuildHeader[]> {
    return request("GET", "/api/builds");
  },

  getBuild(id: number): Promise<BuildDetail> {
    return request("GET", `/api/builds/${id}`);
  },

  createBuild(input: CreateBuildInput): Promise<{ id: number }> {
    return request("POST", "/api/builds", input);
  },

  deleteBuild(id: number): Promise<void> {
    return request("DELETE", `/api/builds/${id}`);
  },

  activateBuild(id: number): Promise<void> {
    return request("POST", `/api/builds/${id}/activate`);
  },

  // Клонирует сборку со всеми файлами в новую (неактивную). Имя
  // необязательное — сервер сам подставит «<имя> (копия)».
  cloneBuild(id: number, name?: string): Promise<{ id: number }> {
    return request("POST", `/api/builds/${id}/clone`, name ? { name } : {});
  },

  // Загрузка с прогрессом через XHR (fetch не даёт upload-progress).
  uploadFileProgress(
    buildId: number,
    file: File,
    meta: UploadMeta,
    onProgress?: (fraction: number) => void,
  ): Promise<BuildFile> {
    return new Promise<BuildFile>((resolve, reject) => {
      const form = new FormData();
      form.append("meta", JSON.stringify(meta));
      form.append("file", file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/builds/${buildId}/files`);
      const token = getToken();
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        const text = xhr.responseText;
        const data = text ? safeJson(text) : undefined;
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data as BuildFile);
        } else {
          const message =
            data && typeof data === "object" && "error" in data
              ? String((data as { error: unknown }).error)
              : `Ошибка ${xhr.status}`;
          reject(new ApiError(xhr.status, message));
        }
      };
      xhr.onerror = () =>
        reject(new ApiError(0, "Сетевая ошибка при загрузке"));
      xhr.send(form);
    });
  },

  // Создаёт новый (по умолчанию пустой) файл по пути. Содержимое
  // редактируется отдельно через редактор. Реализовано поверх загрузки.
  createFile(
    buildId: number,
    meta: UploadMeta,
    content = "",
  ): Promise<BuildFile> {
    const file = new File([content], baseName(meta.path), {
      type: "text/plain",
    });
    return this.uploadFileProgress(buildId, file, meta);
  },

  deleteFile(fileId: number): Promise<void> {
    return request("DELETE", `/api/builds/files/${fileId}`);
  },

  updateFile(fileId: number, patch: Partial<UploadMeta>): Promise<BuildFile> {
    return request("PATCH", `/api/builds/files/${fileId}`, patch);
  },

  // Содержимое файла читаем напрямую из контент-адресного хранилища по sha1.
  async getFileContent(sha1: string): Promise<string> {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const resp = await fetch(`/files/${sha1}`, { headers });
    if (!resp.ok) throw new ApiError(resp.status, `Ошибка ${resp.status}`);
    return resp.text();
  },

  updateFileContent(fileId: number, content: string): Promise<BuildFile> {
    return request("PUT", `/api/builds/files/${fileId}/content`, { content });
  },

  listAccounts(): Promise<Account[]> {
    return request("GET", "/api/accounts");
  },

  renameAccount(uuid: string, username: string): Promise<Account> {
    return request("PATCH", `/api/accounts/${uuid}`, { username });
  },

  deleteAccount(uuid: string): Promise<void> {
    return request("DELETE", `/api/accounts/${uuid}`);
  },

  banAccount(
    uuid: string,
    opts: { durationSecs?: number; reason?: string } = {},
  ): Promise<Account> {
    return request("POST", `/api/accounts/${uuid}/ban`, opts);
  },

  unbanAccount(uuid: string): Promise<Account> {
    return request("POST", `/api/accounts/${uuid}/unban`);
  },

  setRole(uuid: string, role: "admin" | "user"): Promise<Account> {
    return request("POST", `/api/accounts/${uuid}/role`, { role });
  },

  // Сброс пароля аккаунта админом (старый пароль не нужен).
  setPassword(uuid: string, password: string): Promise<void> {
    return request("POST", `/api/accounts/${uuid}/password`, { password });
  },

  // Отвязать Telegram от аккаунта (например, игрок потерял доступ).
  unlinkTelegram(uuid: string): Promise<Account> {
    return request("DELETE", `/api/accounts/${uuid}/telegram`);
  },

  // Вручную задать или очистить Telegram chat_id у аккаунта.
  setTelegram(uuid: string, chatId: string | null): Promise<Account> {
    return request("PUT", `/api/accounts/${uuid}/telegram`, {
      chat_id: chatId,
    });
  },

  getSettings(): Promise<Settings> {
    return request("GET", "/api/settings");
  },

  updateBuild(id: number, input: CreateBuildInput): Promise<void> {
    return request("PATCH", `/api/builds/${id}`, input);
  },

  syncToPanel(
    buildId: number,
  ): Promise<{ uploaded: number; skipped: number; deleted: number; inProgress?: boolean }> {
    return request("POST", `/api/builds/${buildId}/sync-to-panel`);
  },

  saveSettings(patch: {
    telegramToken?: string;
    sftpHost?: string;
    sftpUsername?: string;
    sftpPassword?: string;
    sftpStatsPath?: string;
  }): Promise<Settings> {
    return request("PUT", "/api/settings", patch);
  },

  syncStats(): Promise<{ updated: number }> {
    return request("POST", "/api/settings/sync-stats");
  },

  buildCheck(buildId?: number): Promise<BuildCheckResult> {
    const qs = buildId != null ? `?build_id=${buildId}` : "";
    return request("GET", `/api/build-check${qs}`);
  },

  depsCheck(buildId?: number): Promise<DepsCheckResult> {
    const qs = buildId != null ? `?build_id=${buildId}` : "";
    return request("GET", `/api/deps-check${qs}`);
  },

  getAccountStats(uuid: string): Promise<PlayerStats> {
    return request("GET", `/api/accounts/${uuid}/stats`);
  },

  // Скин аккаунта тянем PNG-ом с bearer-токеном и отдаём как object URL
  // (для рисования головы на canvas). 404 — скина нет, вернём null.
  async getAccountSkinUrl(uuid: string): Promise<string | null> {
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const resp = await fetch(`/api/accounts/${uuid}/skin`, { headers });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new ApiError(resp.status, `Ошибка ${resp.status}`);
    const blob = await resp.blob();
    return URL.createObjectURL(blob);
  },

  // ───── Кастомизация ника ─────

  listBadges(): Promise<Badge[]> {
    return request("GET", "/api/badges");
  },

  createBadge(emoji: string, label: string, color: string): Promise<Badge> {
    return request("POST", "/api/badges", { emoji, label, color });
  },

  updateBadge(id: number, emoji: string, label: string, color: string): Promise<void> {
    return request("PATCH", `/api/badges/${id}`, { emoji, label, color });
  },

  deleteBadge(id: number): Promise<void> {
    return request("DELETE", `/api/badges/${id}`);
  },

  listGradients(): Promise<Gradient[]> {
    return request("GET", "/api/gradients");
  },

  createGradient(label: string, colorStart: string, colorEnd: string): Promise<Gradient> {
    return request("POST", "/api/gradients", { label, colorStart, colorEnd });
  },

  updateGradient(id: number, label: string, colorStart: string, colorEnd: string): Promise<void> {
    return request("PATCH", `/api/gradients/${id}`, { label, colorStart, colorEnd });
  },

  deleteGradient(id: number): Promise<void> {
    return request("DELETE", `/api/gradients/${id}`);
  },

  getAccountCustomization(uuid: string): Promise<PlayerCustomization> {
    return request("GET", `/api/accounts/${uuid}/customization`);
  },

  setAccountBadges(uuid: string, ids: number[]): Promise<void> {
    return request("PUT", `/api/accounts/${uuid}/badges`, { ids });
  },

  setAccountGradients(uuid: string, ids: number[]): Promise<void> {
    return request("PUT", `/api/accounts/${uuid}/gradients`, { ids });
  },

  setAccountActive(uuid: string, badgeId: number | null, gradientId: number | null): Promise<void> {
    return request("PUT", `/api/accounts/${uuid}/active`, { badgeId, gradientId });
  },
};
