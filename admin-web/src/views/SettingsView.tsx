import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { Settings } from "../types";
import { useConfirm, useToast } from "../ui/feedback";
import { IconKey, IconSettings, IconTelegram } from "../ui/icons";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/shadcn";

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
  const [resettingFp, setResettingFp] = useState(false);

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

  async function resetFingerprint() {
    const ok = await confirm({
      title: "Сбросить отпечаток сервера?",
      body: "Файл known_hosts.json будет удалён. При следующем подключении ключ хоста будет принят заново. Используйте, если вы сменили SSH-ключ на сервере.",
      confirmText: "Сбросить",
      danger: true,
    });
    if (!ok) return;
    setResettingFp(true);
    try {
      await api.resetFingerprint();
      toast.success("Отпечаток сброшен — подключитесь к серверу заново");
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : "Не удалось сбросить отпечаток",
      );
    } finally {
      setResettingFp(false);
    }
  }

  return (
    <div className="view settings-view">
      <header className="view-head page-head">
        <div>
          <span className="eyebrow">Infrastructure</span>
          <h1>Настройки</h1>
          <p className="muted">Интеграции, доставка файлов и вспомогательные артефакты.</p>
        </div>
      </header>

      <div className="settings-status-row">
        <div className="metric-card metric-card--blue"><span>Telegram</span><strong>{settings?.telegramTokenSet ? "online" : "off"}</strong><small>{settings?.telegramBotUsername ? `@${settings.telegramBotUsername}` : "бот не подключён"}</small></div>
        <div className="metric-card metric-card--green"><span>SFTP</span><strong>{settings?.sftpPasswordSet ? "ready" : "setup"}</strong><small>{settings?.sftpHost || "host не задан"}</small></div>
        <div className="metric-card metric-card--yellow"><span>Stats path</span><strong>{settings?.sftpStatsPath ? "set" : "empty"}</strong><small>{settings?.sftpStatsPath || "путь к stats не задан"}</small></div>
      </div>

      <div className="settings-grid">
        <Card className="settings-card">
          <CardHeader className="settings-card-head">
            <IconTelegram />
            <div>
              <CardTitle>Telegram-бот</CardTitle>
              <CardDescription>
                Токен от @BotFather. Используется для привязки аккаунтов и
                восстановления доступа.
              </CardDescription>
            </div>
          </CardHeader>

          {loading ? (
            <p className="muted">
              <span className="spinner" />
              Загрузка…
            </p>
          ) : (
            <CardContent>
              <div className="settings-status">
                {settings?.telegramTokenSet ? (
                  <Badge variant="secondary">
                    подключён
                    {settings.telegramBotUsername
                      ? ` · @${settings.telegramBotUsername}`
                      : ""}
                  </Badge>
                ) : (
                  <Badge variant="outline">не настроен</Badge>
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
                  <Button
                    variant="destructive"
                    disabled={saving}
                    onClick={clearToken}
                  >
                    Отключить бота
                  </Button>
                )}
                <Button
                  disabled={!token.trim() || saving}
                  onClick={saveToken}
                >
                  Сохранить токен
                </Button>
              </div>
            </CardContent>
          )}
        </Card>

        <Card className="settings-card">
          <CardHeader className="settings-card-head">
            <IconSettings />
            <div>
              <CardTitle>Minecraft-сервер</CardTitle>
              <CardDescription>
                Подключение по SFTP для загрузки файлов сборки на сервер.
              </CardDescription>
            </div>
          </CardHeader>

          {loading ? (
            <p className="muted">
              <span className="spinner" />
              Загрузка…
            </p>
          ) : (
            <CardContent>
              <div className="settings-status">
                {settings?.sftpPasswordSet ? (
                  <Badge variant="secondary">пароль установлен</Badge>
                ) : (
                  <Badge variant="outline">не настроено</Badge>
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
                <Button
                  variant="destructive"
                  disabled={resettingFp}
                  onClick={resetFingerprint}
                >
                  Сбросить отпечаток
                </Button>
                <Button
                  disabled={savingPanel}
                  onClick={savePanel}
                >
                  Сохранить
                </Button>
              </div>
            </CardContent>
          )}
        </Card>

        <Card className="settings-card">
          <CardHeader className="settings-card-head">
            <IconKey />
            <div>
              <CardTitle>authlib-injector</CardTitle>
              <CardDescription>
                Агент для подмены сервиса авторизации в Minecraft. Скачайте и
                добавьте в JVM-аргументы лаунчера.
              </CardDescription>
            </div>
          </CardHeader>
          <a
            className="btn-download"
            href="/authlib-injector.jar"
            download="authlib-injector.jar"
          >
            Скачать authlib-injector.jar
          </a>
        </Card>
      </div>
    </div>
  );
}
