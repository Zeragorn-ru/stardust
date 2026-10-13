import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { BackupStatus, Settings } from "../types";
import { useConfirm, useToast } from "../ui/feedback";
import { IconBox, IconKey, IconSettings, IconTelegram } from "../ui/icons";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/shadcn";
import { Field, FieldInput } from "../ui/Field";
import { formatDateTime, formatSize } from "../format";

/** Секции настроек (план 2.4/3.4): якорная поднавигация + scroll-spy. */
const SETTINGS_SECTIONS = [
  { id: "settings-integrations", label: "Интеграции" },
  { id: "settings-backups", label: "Бекапы" },
  { id: "settings-game", label: "Игра" },
  { id: "settings-artifacts", label: "Артефакты" },
] as const;

const BACKUP_POLL_MS = 5000;

/** Человекочитаемая строка статуса бекапа (план 3.4). */
function backupStatusText(status: BackupStatus | null): string {
  const state = status?.state ?? status?.status;
  switch (state) {
    case "running":
      return "Идёт архивация…";
    case "success":
      return `Последний запуск: ${formatDateTime(status?.finishedAt ?? status?.lastRunAt ?? "")}`;
    case "error":
      return `Последний запуск завершился ошибкой: ${status?.error ?? "причина неизвестна"}`;
    case "disabled":
      return "Автоматические бекапы отключены (нет настроек)";
    case "idle":
    case undefined:
    case null:
      return status?.lastRunAt || status?.startedAt
        ? `Последний запуск: ${formatDateTime(status.lastRunAt ?? status.startedAt ?? "")}`
        : "Бекапы ещё не запускались";
    default:
      return `Статус: ${state}`;
  }
}

const BACKUP_RUNNING_REASONS: Record<string, string> = {
  running: "Идёт архивация — дождитесь завершения",
};

export function SettingsView() {
  const toast = useToast();
  const confirm = useConfirm();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [backupStatusLoading, setBackupStatusLoading] = useState(true);
  const [token, setTokenValue] = useState("");
  const [saving, setSaving] = useState(false);

  // Подсветка активной секции в якорной поднавигации (scroll-spy).
  const [activeSection, setActiveSection] = useState<string>(SETTINGS_SECTIONS[0].id);
  const sectionsRef = useRef<HTMLDivElement | null>(null);

  // SFTP fields
  const [sftpHost, setSftpHost] = useState("");
  const [sftpUsername, setSftpUsername] = useState("");
  const [sftpPassword, setSftpPassword] = useState("");
  const [sftpStatsPath, setSftpStatsPath] = useState("");
  const [savingPanel, setSavingPanel] = useState(false);
  const [telemetryToken, setTelemetryToken] = useState("");
  const [generatingTelemetryToken, setGeneratingTelemetryToken] = useState(false);
  const [resettingFp, setResettingFp] = useState(false);

  // Yandex Object Storage fields. Secret values are never loaded from the API.
  const [backupEndpoint, setBackupEndpoint] = useState("");
  const [backupBucket, setBackupBucket] = useState("");
  const [backupRegion, setBackupRegion] = useState("");
  const [backupPrefix, setBackupPrefix] = useState("");
  const [backupAccessKey, setBackupAccessKey] = useState("");
  const [backupSecretKey, setBackupSecretKey] = useState("");
  const [savingBackup, setSavingBackup] = useState(false);
  const [runningBackup, setRunningBackup] = useState(false);
  const [achievementCoinReward, setAchievementCoinReward] = useState(10);
  const [savingAchievementReward, setSavingAchievementReward] = useState(false);

  // GitHub токен для релизов лаунчера (секрет: наружу не отдаётся, только
  // флаг установлен/нет; пустое поле при сохранении = не менять).
  const [githubToken, setGithubToken] = useState("");
  const [savingGithubToken, setSavingGithubToken] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.getSettings();
      setSettings(s);
      setAchievementCoinReward(s.achievementCoinReward ?? 10);
      setSftpHost(s.sftpHost ?? "");
      setSftpUsername(s.sftpUsername ?? "");
      setSftpStatsPath(s.sftpStatsPath ?? "");
      setBackupEndpoint(s.backupEndpoint ?? "");
      setBackupBucket(s.backupBucket ?? "");
      setBackupRegion(s.backupRegion ?? "");
      setBackupPrefix(s.backupPrefix ?? "");
      try {
        setBackupStatus(await api.getBackupStatus());
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) {
          toast.error(
            err instanceof ApiError ? err.message : "Не удалось загрузить статус бекапа",
          );
        }
      }
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : "Не удалось загрузить настройки",
      );
    } finally {
      setLoading(false);
      setBackupStatusLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Опрос статуса бекапа (план 3.4): пока сервер архивирует, статус
  // тянется каждые ~5 с до терминального состояния. Кнопка запуска
  // заблокирована от опрашиваемого статуса, причина — рядом.
  const backupState = backupStatus?.state ?? backupStatus?.status;
  const backupRunning = backupState === "running";
  useEffect(() => {
    if (!backupRunning) return;
    const timer = window.setInterval(async () => {
      try {
        setBackupStatus(await api.getBackupStatus());
      } catch {
        /* следующий тик повторит попытку */
      }
    }, BACKUP_POLL_MS);
    return () => window.clearInterval(timer);
  }, [backupRunning]);

  // Scroll-spy: подсвечиваем секцию, чей заголовок пересёк верх экрана.
  useEffect(() => {
    const container = sectionsRef.current;
    if (!container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // Берём верхнюю видимую секцию с положительным intersectionRatio.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActiveSection(visible[0].target.id);
      },
      { rootMargin: "-96px 0px -60% 0px", threshold: 0 },
    );
    for (const section of SETTINGS_SECTIONS) {
      const el = document.getElementById(section.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [loading]);

  function scrollToSection(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    // Смещение под фиксированный/липкий верх шапки, чтобы заголовок
    // секции не прятался под ним.
    const top = el.getBoundingClientRect().top + window.scrollY - 90;
    window.scrollTo({ top, behavior: "smooth" });
    setActiveSection(id);
  }

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

  async function saveBackup() {
    setSavingBackup(true);
    try {
      const patch: {
        backupEndpoint: string;
        backupBucket: string;
        backupRegion: string;
        backupPrefix: string;
        backupAccessKey?: string;
        backupSecretKey?: string;
      } = {
        backupEndpoint: backupEndpoint.trim(),
        backupBucket: backupBucket.trim(),
        backupRegion: backupRegion.trim(),
        backupPrefix: backupPrefix.trim(),
      };
      if (backupAccessKey.trim()) patch.backupAccessKey = backupAccessKey.trim();
      if (backupSecretKey.trim()) patch.backupSecretKey = backupSecretKey.trim();

      const next = await api.saveSettings(patch);
      setSettings(next);
      setBackupEndpoint(next.backupEndpoint ?? "");
      setBackupBucket(next.backupBucket ?? "");
      setBackupRegion(next.backupRegion ?? "");
      setBackupPrefix(next.backupPrefix ?? "");
      setBackupAccessKey("");
      setBackupSecretKey("");
      toast.success("Настройки бекапов сохранены");
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось сохранить настройки бекапов",
      );
    } finally {
      setSavingBackup(false);
    }
  }

  async function saveGithubToken() {
    const trimmed = githubToken.trim();
    if (!trimmed) return;
    setSavingGithubToken(true);
    try {
      const next = await api.saveSettings({ githubToken: trimmed });
      setSettings(next);
      setGithubToken("");
      toast.success("GitHub токен сохранён");
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось сохранить GitHub токен",
      );
    } finally {
      setSavingGithubToken(false);
    }
  }

  async function saveAchievementReward() {
    const reward = Math.trunc(achievementCoinReward);
    if (reward < 0 || reward > 1_000_000) {
      toast.error("Укажите значение от 0 до 1 000 000");
      return;
    }
    setSavingAchievementReward(true);
    try {
      const next = await api.saveSettings({ achievementCoinReward: reward });
      setSettings(next);
      setAchievementCoinReward(next.achievementCoinReward ?? reward);
      toast.success("Награда за достижения сохранена");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Не удалось сохранить награду");
    } finally {
      setSavingAchievementReward(false);
    }
  }

  async function runBackup() {
    setRunningBackup(true);
    try {
      await api.runBackup();
      // Старт принят: сразу тянем статус — сервер переводит его в
      // «running», и дальше опрос ведёт до терминального состояния.
      setBackupStatus(await api.getBackupStatus());
      toast.success("Бекап запущен");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Не удалось запустить бекап");
    } finally {
      setRunningBackup(false);
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

  async function generateTelemetryToken() {
    setGeneratingTelemetryToken(true);
    try {
      const result = await api.generateServerTelemetryToken();
      setTelemetryToken(result.token);
      setSettings(await api.getSettings());
      toast.success("Токен телеметрии сгенерирован");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Не удалось сгенерировать токен");
    } finally {
      setGeneratingTelemetryToken(false);
    }
  }

  const backupDisabledReason = runningBackup
    ? "Запуск…"
    : backupRunning
      ? (BACKUP_RUNNING_REASONS[backupState ?? ""] ?? "Идёт архивация — дождитесь завершения")
      : null;

  return (
    <div className="view settings-view">
      <header className="view-head page-head">
        <div>
          <span className="eyebrow">Платформа</span>
          <h1>Настройки</h1>
          <p className="muted">Интеграции, бекапы, игровые правила и служебные артефакты.</p>
        </div>
      </header>

      {/* Якорная поднавигация по секциям (план 2.4/3.4): липкая строка,
          активная секция подсвечивается scroll-spy. */}
      <nav className="settings-subnav" aria-label="Разделы настроек">
        {SETTINGS_SECTIONS.map((section) => (
          <button
            key={section.id}
            type="button"
            className={`settings-subnav-item${activeSection === section.id ? " active" : ""}`}
            aria-current={activeSection === section.id ? "true" : undefined}
            onClick={() => scrollToSection(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>

      <div className="settings-status-row">
        <div className="metric-card metric-card--blue"><span>Telegram</span><strong>{settings?.telegramTokenSet ? "подключён" : "отключён"}</strong><small>{settings?.telegramBotUsername ? `@${settings.telegramBotUsername}` : "бот не подключён"}</small></div>
        <div className="metric-card metric-card--green"><span>SFTP</span><strong>{settings?.sftpPasswordSet ? "готов" : "настроить"}</strong><small>{settings?.sftpHost || "хост не задан"}</small></div>
        <div className="metric-card metric-card--yellow"><span>Путь статистики</span><strong>{settings?.sftpStatsPath ? "задан" : "пусто"}</strong><small>{settings?.sftpStatsPath || "путь к stats не задан"}</small></div>
        <div className="metric-card metric-card--blue"><span>GitHub</span><strong>{settings?.githubTokenSet ? "токен задан" : "не настроен"}</strong><small>{settings?.githubTokenSet ? "релизы лаунчера доступны" : "нужен для стабильных релизов"}</small></div>
      </div>

      <div ref={sectionsRef} className="settings-sections">
        {/* ── Интеграции ─────────────────────────────────────────── */}
        <section id="settings-integrations" className="settings-section" aria-labelledby="settings-integrations-title">
          <h2 id="settings-integrations-title" className="settings-section-title">Интеграции</h2>
          <p className="muted">Telegram-бот, SFTP-доступ к серверу, телеметрия и GitHub для релизов.</p>

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

                  <Field
                    label={settings?.telegramTokenSet
                      ? "Новый токен (заменит текущий)"
                      : "Токен бота"}
                  >
                    {(control) => (
                      <FieldInput
                        control={control}
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
                    )}
                  </Field>

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

                  <Field label="Хост (host или host:port)">
                    {(control) => (
                      <FieldInput
                        control={control}
                        type="text"
                        placeholder="mc.example.com:2022"
                        value={sftpHost}
                        onChange={(e) => setSftpHost(e.target.value)}
                      />
                    )}
                  </Field>

                  <Field label="Логин">
                    {(control) => (
                      <FieldInput
                        control={control}
                        type="text"
                        autoComplete="off"
                        placeholder="user"
                        value={sftpUsername}
                        onChange={(e) => setSftpUsername(e.target.value)}
                      />
                    )}
                  </Field>

                  <Field
                    label={settings?.sftpPasswordSet
                      ? "Пароль (оставьте пустым, чтобы не менять)"
                      : "Пароль"}
                  >
                    {(control) => (
                      <FieldInput
                        control={control}
                        type="password"
                        autoComplete="off"
                        placeholder="••••••••"
                        value={sftpPassword}
                        onChange={(e) => setSftpPassword(e.target.value)}
                      />
                    )}
                  </Field>

                  <Field label="Путь к папке статистики">
                    {(control) => (
                      <FieldInput
                        control={control}
                        type="text"
                        placeholder="/home/user/minecraft/world/stats"
                        value={sftpStatsPath}
                        onChange={(e) => setSftpStatsPath(e.target.value)}
                      />
                    )}
                  </Field>

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
                  <CardTitle>Телеметрия сервера</CardTitle>
                  <CardDescription>Токен защищает отправку онлайна, TPS и MSPT из мода.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <div className="settings-status"><Badge variant={settings?.serverTelemetryTokenSet ? "secondary" : "outline"}>{settings?.serverTelemetryTokenSet ? "токен задан" : "не настроен"}</Badge></div>
                <p className="muted">Сгенерируйте токен, вставьте его на Minecraft-сервер в <code>config/stardust-server.properties</code>, затем выполните <code>/stardust reload</code>.</p>
                <div className="modal-actions"><Button disabled={generatingTelemetryToken} onClick={generateTelemetryToken}>{generatingTelemetryToken ? "Генерация…" : "Сгенерировать токен"}</Button></div>
                {telemetryToken && (
                  <div className="telemetry-token-row">
                    <textarea className="telemetry-token-output" readOnly value={`stardust.server-token=${telemetryToken}`} onFocus={(event) => event.currentTarget.select()} />
                    <Button
                      variant="secondary"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(`stardust.server-token=${telemetryToken}`);
                          toast.success("Токен скопирован");
                        } catch {
                          toast.error("Не удалось скопировать токен");
                        }
                      }}
                    >
                      Копировать
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="settings-card">
              <CardHeader className="settings-card-head">
                <IconKey />
                <div>
                  <CardTitle>GitHub токен</CardTitle>
                  <CardDescription>
                    Токен с правами repo — для выката релизов лаунчера в стабильные.
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
                    {settings?.githubTokenSet ? (
                      <Badge variant="secondary">токен установлен</Badge>
                    ) : (
                      <Badge variant="outline">не настроен</Badge>
                    )}
                  </div>

                  <Field
                    label={settings?.githubTokenSet
                      ? "Новый токен (оставьте пустым, чтобы не менять)"
                      : "Токен доступа (classic fine-grained, scope repo)"}
                  >
                    {(control) => (
                      <FieldInput
                        control={control}
                        type="password"
                        autoComplete="off"
                        placeholder="ghp_… или github_pat_…"
                        value={githubToken}
                        onChange={(e) => setGithubToken(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && githubToken.trim() && !savingGithubToken)
                            saveGithubToken();
                        }}
                      />
                    )}
                  </Field>

                  <p className="muted">
                    Используется при переводе pre-release лаунчера в стабильный релиз на экране «Сезоны».
                  </p>

                  <div className="modal-actions">
                    <Button
                      disabled={!githubToken.trim() || savingGithubToken}
                      onClick={saveGithubToken}
                    >
                      {savingGithubToken ? "Сохранение…" : "Сохранить токен"}
                    </Button>
                  </div>
                </CardContent>
              )}
            </Card>
          </div>
        </section>

        {/* ── Бекапы ──────────────────────────────────────────────── */}
        <section id="settings-backups" className="settings-section" aria-labelledby="settings-backups-title">
          <h2 id="settings-backups-title" className="settings-section-title">Бекапы</h2>
          <p className="muted">Резервные копии данных в S3-совместимом хранилище и ручной запуск архивации.</p>

          <div className="settings-grid">
            <Card className="settings-card">
              <CardHeader className="settings-card-head">
                <IconBox />
                <div>
                  <CardTitle>Бекапы в Yandex Object Storage</CardTitle>
                  <CardDescription>
                    S3-совместимое хранилище для резервных копий. Ключи не показываются после сохранения.
                  </CardDescription>
                </div>
              </CardHeader>

              {loading ? (
                <p className="muted"><span className="spinner" />Загрузка…</p>
              ) : (
                <CardContent>
                  <div className="settings-status">
                    <Badge variant={settings?.backupSecretKeySet ? "secondary" : "outline"}>
                      {settings?.backupSecretKeySet ? "настроено" : "не настроено"}
                    </Badge>
                    {backupStatusLoading ? (
                      <span className="muted">Проверка статуса…</span>
                    ) : (
                      <span className="muted">{backupStatusText(backupStatus)}</span>
                    )}
                  </div>

                  <Field label="Endpoint">
                    {(control) => (
                      <FieldInput
                        control={control}
                        type="url"
                        placeholder="https://storage.yandexcloud.net"
                        value={backupEndpoint}
                        onChange={(e) => setBackupEndpoint(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label="Bucket">
                    {(control) => (
                      <FieldInput
                        control={control}
                        type="text"
                        placeholder="my-backups"
                        value={backupBucket}
                        onChange={(e) => setBackupBucket(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label="Region">
                    {(control) => (
                      <FieldInput
                        control={control}
                        type="text"
                        placeholder="ru-central1"
                        value={backupRegion}
                        onChange={(e) => setBackupRegion(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label="Prefix">
                    {(control) => (
                      <FieldInput
                        control={control}
                        type="text"
                        placeholder="stardust/"
                        value={backupPrefix}
                        onChange={(e) => setBackupPrefix(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field
                    label={`Access key${settings?.backupAccessKeySet ? " (пусто — не менять)" : ""}`}
                  >
                    {(control) => (
                      <FieldInput
                        control={control}
                        type="password"
                        autoComplete="off"
                        placeholder="••••••••"
                        value={backupAccessKey}
                        onChange={(e) => setBackupAccessKey(e.target.value)}
                      />
                    )}
                  </Field>
                  <Field
                    label={`Secret key${settings?.backupSecretKeySet ? " (пусто — не менять)" : ""}`}
                  >
                    {(control) => (
                      <FieldInput
                        control={control}
                        type="password"
                        autoComplete="new-password"
                        placeholder="••••••••"
                        value={backupSecretKey}
                        onChange={(e) => setBackupSecretKey(e.target.value)}
                      />
                    )}
                  </Field>

                  {backupStatus?.error && <p className="muted">Ошибка последнего запуска: {backupStatus.error}</p>}
                  {backupStatus?.lastSizeBytes != null && (
                    <p className="muted">Размер последнего архива: {formatSize(backupStatus.lastSizeBytes)}</p>
                  )}
                  <div className="modal-actions">
                    <Button disabled={savingBackup} onClick={saveBackup}>{savingBackup ? "Сохранение…" : "Сохранить настройки"}</Button>
                    <Button
                      variant="secondary"
                      disabled={runningBackup || backupRunning}
                      onClick={runBackup}
                    >
                      {runningBackup ? "Запуск…" : "Запустить бекап"}
                    </Button>
                  </div>
                  {/* Причина блокировки кнопки запуска — рядом с ней
                      (план 3.4): статус опрашивается, текст живой. */}
                  {backupDisabledReason && (
                    <p className="muted" role="status">{backupDisabledReason}</p>
                  )}
                </CardContent>
              )}
            </Card>
          </div>
        </section>

        {/* ── Игра ────────────────────────────────────────────────── */}
        <section id="settings-game" className="settings-section" aria-labelledby="settings-game-title">
          <h2 id="settings-game-title" className="settings-section-title">Игра</h2>
          <p className="muted">Правила начислений, влияющие на игровой процесс.</p>

          <div className="settings-grid">
            <Card className="settings-card">
              <CardHeader className="settings-card-head">
                <IconKey />
                <div>
                  <CardTitle>Монеты за достижения</CardTitle>
                  <CardDescription>
                    Базовая награда, которая будет начисляться игроку за каждое подтверждённое Minecraft-достижение.
                  </CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                <Field label="Монет за достижение">
                  {(control) => (
                    <FieldInput
                      control={control}
                      type="number"
                      min={0}
                      max={1000000}
                      step={1}
                      value={achievementCoinReward}
                      onChange={(event) => setAchievementCoinReward(Number(event.target.value))}
                    />
                  )}
                </Field>
                <p className="muted">Изменение настройки не начисляет монеты задним числом.</p>
                <div className="modal-actions">
                  <Button disabled={savingAchievementReward} onClick={saveAchievementReward}>
                    {savingAchievementReward ? "Сохранение…" : "Сохранить награду"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* ── Артефакты ───────────────────────────────────────────── */}
        <section id="settings-artifacts" className="settings-section" aria-labelledby="settings-artifacts-title">
          <h2 id="settings-artifacts-title" className="settings-section-title">Артефакты</h2>
          <p className="muted">Служебные файлы, распространяемые панелью.</p>

          <div className="settings-grid">
            <Card className="settings-card">
              <CardHeader className="settings-card-head">
                <IconKey />
                <div>
                  <CardTitle>authlib-injector</CardTitle>
                  <CardDescription>
                    Последняя StarDust-сборка Java-agent для авторизации Minecraft.
                    Injector автоматически обновляется в лаунчере; для сервера скачайте
                    этот файл и добавьте его в JVM-аргументы.
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
        </section>
      </div>
    </div>
  );
}
