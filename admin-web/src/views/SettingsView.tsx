import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Settings } from "../types";
import { useConfirm, useToast } from "../ui/feedback";
import { IconDownload, IconKey, IconSettings, IconTelegram } from "../ui/icons";

export function SettingsView() {
  const toast = useToast();
  const confirm = useConfirm();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setTokenValue] = useState("");
  const [saving, setSaving] = useState(false);

  // SFTP fields
  const [sftpHost, setSftpHost] = useState("");
  const [sftpUsername, setSftpUsername] = useState("");
  const [sftpPassword, setSftpPassword] = useState("");
  const [sftpStatsPath, setSftpStatsPath] = useState("");
  const [savingPanel, setSavingPanel] = useState(false);
  const [syncingStats, setSyncingStats] = useState(false);

  // Deploy mod
  const [deploying, setDeploying] = useState(false);
  const [deployStatus, setDeployStatus] = useState<{
    state: string;
    phase: string;
    version: string | null;
    error: string | null;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setSettings(s);
      setSftpHost(s.sftpHost ?? "");
      setSftpUsername(s.sftpUsername ?? "");
      setSftpStatsPath(s.sftpStatsPath ?? "");
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : "Не удалось загрузить настройки",
      );
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveToken() {
    const trimmed = token.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const next = await api.saveSettings({ telegramToken: trimmed });
      setSettings(next);
      setTokenValue("");
      toast.success("Токен бота сохранён");
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось сохранить токен",
      );
    } finally {
      setSaving(false);
    }
  }

  async function clearToken() {
    const ok = await confirm({
      title: "Отключить Telegram-бота?",
      body: "Токен будет удалён. Привязка аккаунтов к Telegram сохранится, но бот перестанет отвечать, пока вы не зададите токен снова.",
      confirmText: "Отключить",
      danger: true,
    });
    if (!ok) return;
    setSaving(true);
    try {
      const next = await api.saveSettings({ telegramToken: "" });
      setSettings(next);
      setTokenValue("");
      toast.success("Бот отключён");
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось отключить бота",
      );
    } finally {
      setSaving(false);
    }
  }

  async function savePanel() {
    setSavingPanel(true);
    try {
      const patch: {
        sftpHost?: string;
        sftpUsername?: string;
        sftpPassword?: string;
        sftpStatsPath?: string;
      } = {
        sftpHost,
        sftpUsername,
        sftpStatsPath,
      };
      if (sftpPassword.trim()) patch.sftpPassword = sftpPassword.trim();
      const next = await api.saveSettings(patch);
      setSettings(next);
      setSftpHost(next.sftpHost ?? "");
      setSftpUsername(next.sftpUsername ?? "");
      setSftpPassword("");
      setSftpStatsPath(next.sftpStatsPath ?? "");
      toast.success("Настройки SFTP сохранены");
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : "Не удалось сохранить настройки SFTP",
      );
    } finally {
      setSavingPanel(false);
    }
  }

  async function syncStats() {
    setSyncingStats(true);
    try {
      const { updated } = await api.syncStats();
      toast.success(`Статистика синхронизирована: обновлено ${updated} игроков`);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось синхронизировать статистику",
      );
    } finally {
      setSyncingStats(false);
    }
  }

  async function deployMod() {
    const ok = await confirm({
      title: "Обновить мод в сборке?",
      body: "Будет скачан последний релиз mod-* из GitHub и добавлен в активную сборку. При следующей синхронизации мод попадёт на сервер.",
      confirmText: "Обновить",
    });
    if (!ok) return;

    setDeploying(true);
    setDeployStatus(null);
    try {
      await api.deployMod();
      // Poll status
      const poll = setInterval(async () => {
        try {
          const s = await api.getDeployModStatus();
          setDeployStatus(s);
          if (s.state === "success" || s.state === "error") {
            clearInterval(poll);
            setDeploying(false);
            if (s.state === "success") {
              toast.success(`Мод ${s.version ?? "?"} добавлен в сборку. Синхронизируйте сервер.`);
            } else {
              toast.error(`Ошибка деплоя: ${s.error ?? "неизвестная ошибка"}`);
            }
          }
        } catch {
          clearInterval(poll);
          setDeploying(false);
        }
      }, 2000);
    } catch (err) {
      setDeploying(false);
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось запустить деплой мода",
      );
    }
  }

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>Настройки</h1>
          <p className="muted">Параметры сервера и вспомогательные файлы</p>
        </div>
      </header>

      <div className="settings-grid">
        <section className="panel settings-card">
          <div className="settings-card-head">
            <IconTelegram />
            <div>
              <h2>Telegram-бот</h2>
              <p className="muted">
                Токен от @BotFather. Используется для привязки аккаунтов и
                восстановления доступа.
              </p>
            </div>
          </div>

          {loading ? (
            <p className="muted">
              <span className="spinner" />
              Загрузка…
            </p>
          ) : (
            <>
              <div className="settings-status">
                {settings?.telegramTokenSet ? (
                  <span className="badge admin">
                    подключён
                    {settings.telegramBotUsername
                      ? ` · @${settings.telegramBotUsername}`
                      : ""}
                  </span>
                ) : (
                  <span className="badge">не настроен</span>
                )}
              </div>

              <label className="fm-prompt-field">
                <span className="muted">
                  {settings?.telegramTokenSet
                    ? "Новый токен (заменит текущий)"
                    : "Токен бота"}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="123456:ABC-DEF…"
                  value={token}
                  onChange={(e) => setTokenValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && token.trim() && !saving)
                      saveToken();
                  }}
                />
              </label>

              <div className="modal-actions">
                {settings?.telegramTokenSet && (
                  <button
                    className="danger"
                    disabled={saving}
                    onClick={clearToken}
                  >
                    Отключить бота
                  </button>
                )}
                <button
                  className="primary"
                  disabled={!token.trim() || saving}
                  onClick={saveToken}
                >
                  Сохранить токен
                </button>
              </div>
            </>
          )}
        </section>

        <section className="panel settings-card">
          <div className="settings-card-head">
            <IconSettings />
            <div>
              <h2>Minecraft-сервер</h2>
              <p className="muted">
                Подключение по SFTP для загрузки файлов сборки на сервер.
              </p>
            </div>
          </div>

          {loading ? (
            <p className="muted">
              <span className="spinner" />
              Загрузка…
            </p>
          ) : (
            <>
              <div className="settings-status">
                {settings?.sftpPasswordSet ? (
                  <span className="badge admin">пароль установлен</span>
                ) : (
                  <span className="badge">не настроено</span>
                )}
              </div>

              <label className="fm-prompt-field">
                <span className="muted">Хост (host или host:port)</span>
                <input
                  type="text"
                  placeholder="mc.example.com:2022"
                  value={sftpHost}
                  onChange={(e) => setSftpHost(e.target.value)}
                />
              </label>

              <label className="fm-prompt-field">
                <span className="muted">Логин</span>
                <input
                  type="text"
                  autoComplete="off"
                  placeholder="user"
                  value={sftpUsername}
                  onChange={(e) => setSftpUsername(e.target.value)}
                />
              </label>

              <label className="fm-prompt-field">
                <span className="muted">
                  {settings?.sftpPasswordSet
                    ? "Пароль (оставьте пустым, чтобы не менять)"
                    : "Пароль"}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="••••••••"
                  value={sftpPassword}
                  onChange={(e) => setSftpPassword(e.target.value)}
                />
              </label>

              <label className="fm-prompt-field">
                <span className="muted">Путь к папке статистики</span>
                <input
                  type="text"
                  placeholder="/home/user/minecraft/world/stats"
                  value={sftpStatsPath}
                  onChange={(e) => setSftpStatsPath(e.target.value)}
                />
              </label>

              <div className="modal-actions">
                <button
                  className="primary"
                  disabled={savingPanel}
                  onClick={savePanel}
                >
                  Сохранить
                </button>
                <button
                  disabled={syncingStats}
                  onClick={syncStats}
                >
                  {syncingStats ? "Синхронизация…" : "Синхронизировать статистику"}
                </button>
              </div>
            </>
          )}
        </section>

        <section className="panel settings-card">
          <div className="settings-card-head">
            <IconKey />
            <div>
              <h2>authlib-injector</h2>
              <p className="muted">
                Агент для подмены сервиса авторизации в Minecraft. Скачайте и
                добавьте в JVM-аргументы лаунчера.
              </p>
            </div>
          </div>
          <a
            className="btn-download"
            href="/authlib-injector.jar"
            download="authlib-injector.jar"
          >
            <IconDownload /> Скачать authlib-injector.jar
          </a>
        </section>

        <section className="panel settings-card">
          <div className="settings-card-head">
            <IconDownload />
            <div>
              <h2>Stardust Mod</h2>
              <p className="muted">
                Обновление серверного мода из последнего релиза GitHub (теги mod-v*).
                Мод добавляется в активную сборку и попадает на сервер при синхронизации.
              </p>
            </div>
          </div>

          <div className="settings-status">
            {deployStatus ? (
              deployStatus.state === "success" ? (
                <span className="badge admin">
                  добавлен в сборку ({deployStatus.version ?? "?"})
                </span>
              ) : deployStatus.state === "error" ? (
                <span className="badge danger">
                  ошибка: {deployStatus.error ?? "неизвестная"}
                </span>
              ) : (
                <span className="badge">
                  <span className="spinner" /> {deployStatus.phase}
                </span>
              )
            ) : (
              <span className="muted">нет активного деплоя</span>
            )}
          </div>

          <div className="modal-actions">
            <button className="primary" disabled={deploying} onClick={deployMod}>
              {deploying ? "Обновление…" : "Обновить мод на сервере"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
