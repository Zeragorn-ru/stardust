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

  uploadFile(
    buildId: number,
    file: File,
    meta: UploadMeta,
  ): Promise<BuildFile> {
    const form = new FormData();
    form.append("meta", JSON.stringify(meta));
    form.append("file", file, file.name);
    return request("POST", `/api/builds/${buildId}/files`, form);
  },

  deleteFile(fileId: number): Promise<void> {
    return request("DELETE", `/api/builds/files/${fileId}`);
  },

  listAccounts(): Promise<Account[]> {
    return request("GET", "/api/accounts");
  },
};
