// Тонкая обёртка над Tauri-командами бэкенда.
//
// В окне приложения вызовы идут в Rust через `invoke`. Если приложение
// открыто вне Tauri (просто `vite dev` в браузере), `invoke` недоступен —
// тогда используем локальные фолбэки (память + localStorage), чтобы
// интерфейс оставался кликабельным при разработке вёрстки.

import type {
  AccountInfo,
  AppInfo,
  OptionalMod,
  PlayerProfile,
  Progress,
  Settings,
  Skin,
  SkinModel,
  UpdateInfo,
} from "./types";

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

// Достаём `invoke` лениво: модуль Tauri есть только в окне приложения.
async function getInvoke(): Promise<InvokeFn | null> {
  try {
    const mod = await import("@tauri-apps/api/core");
    return mod.invoke as InvokeFn;
  } catch {
    return null;
  }
}

const FALLBACK_SETTINGS: Settings = {
  memoryMb: 4096,
};

// Ключи для dev-фолбэка в браузере.
const LS_SKIN = "dev.skin.dataUrl";
const LS_SKIN_MODEL = "dev.skin.model";

async function getCurrentWindow() {
  try {
    const mod = await import("@tauri-apps/api/window");
    return mod.getCurrentWindow();
  } catch {
    return null;
  }
}

export async function minimizeWindow(): Promise<void> {
  const win = await getCurrentWindow();
  await win?.minimize();
}

export async function closeWindow(): Promise<void> {
  const win = await getCurrentWindow();
  await win?.close();
}

export async function startWindowDrag(): Promise<void> {
  const win = await getCurrentWindow();
  await win?.startDragging();
}

export async function onLauncherProgress(
  handler: (progress: Progress) => void,
): Promise<() => void> {
  try {
    const mod = await import("@tauri-apps/api/event");
    return mod.listen<Progress>("launcher://progress", (event) => {
      handler(event.payload);
    });
  } catch {
    return () => undefined;
  }
}

/** Вход по логину/паролю на auth-сервере. */
export async function login(
  username: string,
  password: string,
): Promise<PlayerProfile> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(500);
    if (!username || !password) throw new Error("Введите логин и пароль");
    return { id: "0".repeat(32), name: username };
  }
  return invoke<PlayerProfile>("login", { username, password });
}

/** Регистрация нового аккаунта. */
export async function register(
  username: string,
  password: string,
): Promise<PlayerProfile> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(600);
    if (username.trim().length < 3)
      throw new Error("Имя игрока: минимум 3 символа");
    if (password.length < 6) throw new Error("Пароль: минимум 6 символов");
    return { id: "0".repeat(32), name: username.trim() };
  }
  return invoke<PlayerProfile>("register", { username, password });
}

/** Завершить сессию. */
export async function logout(): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) return;
  await invoke<void>("logout");
}

/** Профиль из сохранённой сессии (автологин), либо null. */
export async function currentProfile(): Promise<PlayerProfile | null> {
  const invoke = await getInvoke();
  if (!invoke) return null;
  return invoke<PlayerProfile | null>("current_profile");
}

/** Расширенные сведения об аккаунте (привязка TG, роль). */
export async function accountInfo(): Promise<AccountInfo> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(200);
    return {
      profile: { id: "0".repeat(32), name: "dev" },
      telegramLinked: false,
      isAdmin: false,
    };
  }
  return invoke<AccountInfo>("account_info");
}

/** Сменить ник. Возвращает обновлённый профиль. */
export async function changeUsername(
  newUsername: string,
): Promise<PlayerProfile> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(400);
    if (newUsername.trim().length < 3)
      throw new Error("Имя игрока: минимум 3 символа");
    return { id: "0".repeat(32), name: newUsername.trim() };
  }
  return invoke<PlayerProfile>("change_username", { newUsername });
}

/** Сменить пароль (требует текущий). */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(400);
    if (newPassword.length < 6) throw new Error("Пароль: минимум 6 символов");
    return;
  }
  await invoke<void>("change_password", { currentPassword, newPassword });
}

/** Удалить собственный аккаунт (требует пароль). После успеха сессия сброшена. */
export async function deleteAccount(password: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(400);
    return;
  }
  await invoke<void>("delete_account", { password });
}

/** Прочитать настройки. */
export async function getSettings(): Promise<Settings> {
  const invoke = await getInvoke();
  if (!invoke) return { ...FALLBACK_SETTINGS };
  return invoke<Settings>("get_settings");
}

/** Сохранить настройки. */
export async function saveSettings(settings: Settings): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) return;
  await invoke<void>("save_settings", { settings });
}

/** Сведения о среде запуска (режим, папка данных, версия). */
export async function getAppInfo(): Promise<AppInfo> {
  const invoke = await getInvoke();
  if (!invoke) {
    return {
      mode: "portable",
      exeDir: "(dev)",
      portableMarker: true,
      dataDir: "(dev) ./data",
      version: "0.1.0",
    };
  }
  return invoke<AppInfo>("app_info");
}

/** Прочитать текущий скин. */
export async function getSkin(): Promise<Skin> {
  const invoke = await getInvoke();
  if (!invoke) {
    return {
      dataUrl: localStorage.getItem(LS_SKIN),
      model: (localStorage.getItem(LS_SKIN_MODEL) as SkinModel) || "classic",
      capeUrl: null,
      source: null,
    };
  }
  return invoke<Skin>("get_skin");
}

/** Сохранить скин (data-URL PNG + модель). */
export async function setSkin(
  dataUrl: string,
  model: SkinModel,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    localStorage.setItem(LS_SKIN, dataUrl);
    localStorage.setItem(LS_SKIN_MODEL, model);
    return;
  }
  await invoke<void>("set_skin", { dataUrl, model });
}

/** Импортировать скин и плащ с лицензионного аккаунта (ник или UUID).
 *
 * При `keepSynced` сервер запомнит UUID источника и будет периодически
 * обновлять скин — привязка переживает смену ника на лицензии. */
export async function importSkinFromLicense(
  source: string,
  keepSynced: boolean,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(600);
    if (!source.trim()) throw new Error("Укажите ник или UUID лицензии");
    throw new Error("Импорт доступен только в приложении");
  }
  await invoke<void>("import_skin_from_license", { source, keepSynced });
}

/** Запустить игру: синхронизация активной сборки (модпака) + старт. */
export async function playGame(): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(800);
    return;
  }
  await invoke<void>("play_game");
}

/** Жив ли сейчас процесс игры. */
export async function gameRunning(): Promise<boolean> {
  const invoke = await getInvoke();
  if (!invoke) {
    return false;
  }
  return invoke<boolean>("game_running");
}

/** Опциональные моды активной сборки с состоянием вкл/выкл. */
export async function listOptionalMods(): Promise<OptionalMod[]> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(300);
    return [];
  }
  return invoke<OptionalMod[]>("list_optional_mods");
}

/** Включить/выключить опциональный мод по его modId. */
export async function setModEnabled(
  modId: string,
  enabled: boolean,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(150);
    return;
  }
  await invoke<void>("set_mod_enabled", { modId, enabled });
}

/** Проверить наличие обновления лаунчера. */
export async function checkUpdate(): Promise<UpdateInfo> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(400);
    return {
      available: false,
      currentVersion: "0.1.0",
      version: null,
      notes: null,
    };
  }
  return invoke<UpdateInfo>("check_update");
}

/** Скачать и установить обновление, затем перезапустить лаунчер. */
export async function installUpdate(): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) return;
  await invoke<void>("install_update");
}

/** Подписаться на прогресс скачивания обновления (доля 0..1 или null). */
export async function onUpdateProgress(
  handler: (fraction: number | null) => void,
): Promise<() => void> {
  try {
    const mod = await import("@tauri-apps/api/event");
    return mod.listen<number | null>("launcher://update-progress", (event) => {
      handler(event.payload);
    });
  } catch {
    return () => undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
