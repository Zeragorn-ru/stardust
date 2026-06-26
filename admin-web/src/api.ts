// HTTP-клиент админки. Токен админа храним в localStorage и шлём как Bearer.
//
// Базовый префикс пустой: в dev запросы идут на относительные пути и
// проксируются Vite на admin-server; в проде статику и API раздаёт один хост.

import type {
  Account,
  BuildDetail,
  BuildFile,
  BuildHeader,
  CreateBuildInput,
  UploadMeta,
} from "./types";

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

// Имя файла из пути (без зависимости от format.ts).
function baseNameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
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
    const file = new File([content], baseNameOf(meta.path), {
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
};
