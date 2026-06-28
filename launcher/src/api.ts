// Тонкая обёртка над Tauri-командами бэкенда.
//
// В окне приложения вызовы идут в Rust через `invoke`. Если приложение
// открыто вне Tauri (просто `vite dev` в браузере), `invoke` недоступен —
// тогда используем локальные фолбэки (память + localStorage), чтобы
// интерфейс оставался кликабельным при разработке вёрстки.

import type {
  AccountInfo,
  AppInfo,
  ChallengeOutcome,
  LoginOutcome,
  OptionalMod,
  PlayerProfile,
  PlayerStats,
  Progress,
  Settings,
  Skin,
  SkinModel,
  TelegramLinkResponse,
  UpdateInfo,
} from "./types";

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

// Достаём `invoke` лениво и кешируем: модуль Tauri есть только в окне приложения.
let _cachedInvoke: InvokeFn | null | undefined;
async function getInvoke(): Promise<InvokeFn | null> {
  if (_cachedInvoke !== undefined) return _cachedInvoke;
  try {
    const mod = await import("@tauri-apps/api/core");
    _cachedInvoke = mod.invoke as InvokeFn;
    return _cachedInvoke;
  } catch {
    _cachedInvoke = null;
    return null;
  }
}

const FALLBACK_SETTINGS: Settings = {
  memoryMb: 4096,
  downloadConcurrency: 6,
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

/** Вход по логину/паролю на auth-сервере.
 *
 * Возвращает либо сессию (профиль), либо требование второго фактора —
 * тогда UI собирает код из Telegram и зовёт `login2fa` с тем же `challenge`. */
export async function login(
  username: string,
  password: string,
): Promise<LoginOutcome> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(500);
    if (!username || !password) throw new Error("Введите логин и пароль");
    return { status: "ok", profile: { id: "0".repeat(32), name: username } };
  }
  return invoke<LoginOutcome>("login", { username, password });
}

/** Подтверждение второго фактора: код из Telegram по `challenge` из `login`. */
export async function login2fa(
  challenge: string,
  code: string,
): Promise<PlayerProfile> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(400);
    if (!code.trim()) throw new Error("Введите код из Telegram");
    return { id: "0".repeat(32), name: "dev" };
  }
  return invoke<PlayerProfile>("login_2fa", { challenge, code });
}

/** Опрос подтверждения входа кнопкой «Это я» в Telegram (обычная 2FA). */
export async function login2faStatus(
  challenge: string,
): Promise<ChallengeOutcome> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(2000);
    return { status: "approved", profile: { id: "0".repeat(32), name: "dev" } };
  }
  return invoke<ChallengeOutcome>("login_2fa_status", { challenge });
}

/** Вход без пароля по нику: подтверждается кнопкой в Telegram. */
export async function passwordlessLogin(
  username: string,
): Promise<LoginOutcome> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(500);
    if (!username.trim()) throw new Error("Введите логин");
    return {
      status: "twoFactorRequired",
      challenge: "dev-challenge",
      hint: "Подтвердите вход в Telegram",
      buttonApproval: true,
    };
  }
  return invoke<LoginOutcome>("passwordless_login", { username });
}

/** Опрос подтверждения входа без пароля. */
export async function passwordlessStatus(
  challenge: string,
): Promise<ChallengeOutcome> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(2000);
    return { status: "approved", profile: { id: "0".repeat(32), name: "dev" } };
  }
  return invoke<ChallengeOutcome>("passwordless_status", { challenge });
}

/** Запуск сброса пароля по нику: подтверждается кнопкой в Telegram. */
export async function passwordResetStart(
  username: string,
): Promise<LoginOutcome> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(500);
    if (!username.trim()) throw new Error("Введите логин");
    return {
      status: "twoFactorRequired",
      challenge: "dev-challenge",
      hint: "Подтвердите сброс пароля в Telegram",
      buttonApproval: true,
    };
  }
  return invoke<LoginOutcome>("password_reset_start", { username });
}

/** Опрос подтверждения сброса пароля. `approved` приходит без профиля. */
export async function passwordResetStatus(
  challenge: string,
): Promise<ChallengeOutcome> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(2000);
    return { status: "approved" };
  }
  return invoke<ChallengeOutcome>("password_reset_status", { challenge });
}

/** Установка нового пароля после подтверждения сброса в Telegram. */
export async function passwordResetConfirm(
  challenge: string,
  newPassword: string,
): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(400);
    if (newPassword.length < 6) throw new Error("Пароль: минимум 6 символов");
    return;
  }
  await invoke<void>("password_reset_confirm", { challenge, newPassword });
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

/** Запросить код привязки Telegram (для включения 2FA). */
export async function telegramLinkStart(): Promise<TelegramLinkResponse> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(300);
    return { code: "DEV12345", botUsername: "stardust_bot" };
  }
  return invoke<TelegramLinkResponse>("telegram_link_start");
}

/** Отвязать Telegram (отключить 2FA). */
export async function telegramUnlink(): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    await delay(300);
    return;
  }
  await invoke<void>("telegram_unlink");
}

/** Открыть внешнюю ссылку в браузере/Telegram через системный обработчик. */
export async function openExternal(url: string): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) {
    window.open(url, "_blank", "noreferrer");
    return;
  }
  await invoke<void>("open_external", { url });
}

/** Открыть папку в файловом менеджере. */
export async function openPath(path: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) await invoke<void>("open_path", { path });
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

/** Статистика игрока (playtime, last_launched_at). */
export async function getStats(): Promise<PlayerStats> {
  const invoke = await getInvoke();
  if (!invoke) {
    return { playtimeSeconds: 0, lastLaunchedAt: null };
  }
  return invoke<PlayerStats>("get_stats");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
