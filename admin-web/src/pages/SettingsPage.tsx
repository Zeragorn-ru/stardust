// Настройки: Telegram, SFTP, бэкапы, интеграции, AI-анализ крашей.
// Секреты сервер наружу не отдаёт — только флаги «задан/не задан»; пустое
// поле означает «не менять», явная очистка — отдельными действиями.

import { useCallback, useState } from "react";
import { api } from "../api";
import type { BackupStatus, Settings } from "../types";
import { useAsyncData } from "../ui/useAsyncData";
import {
  Button,
  Chip,
  CopyButton,
  Field,
  Form,
  FormActions,
  Input,
  PageHeader,
  PageState,
  Panel,
  Switch,
} from "../ui/components";
import { useToast } from "../ui/feedback";
import { useSftpHostKey } from "../ui/sftpHostKey";
import { formatDateTime } from "../format";

export function SettingsPage() {
  const fetcher = useCallback(
    () => Promise.all([api.getSettings(), api.getBackupStatus()]),
    [],
  );
  const { data, loading, error, reload } = useAsyncData(fetcher);

  return (
    <div className="page-stack">
      <PageHeader title="Настройки" />
      <PageState loading={loading} error={error} onRetry={reload}>
        {data && <SettingsBody settings={data[0]} backup={data[1]} onChanged={reload} />}
      </PageState>
    </div>
  );
}

type SavePatch = Parameters<typeof api.saveSettings>[0];

function SettingsBody({
  settings,
  backup,
  onChanged,
}: {
  settings: Settings;
  backup: BackupStatus;
  onChanged: () => void;
}) {
  const toast = useToast();
  const { syncStats } = useSftpHostKey();
  const [busy, setBusy] = useState(false);

  // Локальные черновики полей. Пусто = «не менять» — сервер хранит секреты.
  const [telegramToken, setTelegramToken] = useState("");
  const [sftp, setSftp] = useState({
    host: settings.sftpHost ?? "",
    username: settings.sftpUsername ?? "",
    password: "",
    statsPath: settings.sftpStatsPath ?? "",
  });
  const [backupForm, setBackupForm] = useState({
    endpoint: settings.backupEndpoint ?? "",
    bucket: settings.backupBucket ?? "",
    region: settings.backupRegion ?? "",
    prefix: settings.backupPrefix ?? "",
    accessKey: "",
    secretKey: "",
    password: "",
  });
  const [coinReward, setCoinReward] = useState(String(settings.achievementCoinReward));
  const [githubToken, setGithubToken] = useState("");
  const [crashAi, setCrashAi] = useState({
    enabled: settings.crashAiEnabled ?? false,
    endpoint: settings.crashAiEndpoint ?? "",
    model: settings.crashAiModel ?? "",
    apiKey: "",
  });
  const [curseforgeKey, setCurseforgeKey] = useState("");

  async function save(patch: SavePatch, success: string) {
    setBusy(true);
    try {
      await api.saveSettings(patch);
      toast.success(success);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сохранить настройки");
    } finally {
      setBusy(false);
    }
  }

  async function runAction(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Действие не удалось");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-columns">
      <div className="page-stack">
        <Panel title="Telegram-бот" description="2FA и уведомления игрокам.">
          <Form>
            <Field
              label="Токен бота"
              hint={settings.telegramTokenSet ? `Привязан (@${settings.telegramBotUsername ?? "?"}). Оставьте пустым, чтобы не менять.` : "Ещё не задан"}
              wide
            >
              <Input
                type="password"
                value={telegramToken}
                onChange={(e) => setTelegramToken(e.target.value)}
                autoComplete="off"
              />
            </Field>
            <FormActions>
              <Button
                busy={busy}
                disabled={!telegramToken.trim()}
                onClick={() => {
                  const token = telegramToken;
                  setTelegramToken("");
                  return save({ telegramToken: token }, "Токен бота сохранён");
                }}
              >
                Сохранить токен
              </Button>
            </FormActions>
          </Form>
        </Panel>

        <Panel title="SFTP игрового сервера" description="Деплой сборок и синхронизация статистики.">
          <Form>
            <Field label="Хост">
              <Input value={sftp.host} onChange={(e) => setSftp((s) => ({ ...s, host: e.target.value }))} className="mono" />
            </Field>
            <Field label="Пользователь">
              <Input value={sftp.username} onChange={(e) => setSftp((s) => ({ ...s, username: e.target.value }))} />
            </Field>
            <Field
              label="Пароль"
              hint={settings.sftpPasswordSet ? "Задан. Оставьте пустым, чтобы не менять." : "Ещё не задан"}
            >
              <Input
                type="password"
                value={sftp.password}
                onChange={(e) => setSftp((s) => ({ ...s, password: e.target.value }))}
                autoComplete="new-password"
              />
            </Field>
            <Field label="Путь к статистике">
              <Input value={sftp.statsPath} onChange={(e) => setSftp((s) => ({ ...s, statsPath: e.target.value }))} className="mono" />
            </Field>
            <FormActions>
              <Button
                busy={busy}
                onClick={() =>
                  save(
                    {
                      sftpHost: sftp.host,
                      sftpUsername: sftp.username,
                      ...(sftp.password ? { sftpPassword: sftp.password } : {}),
                      sftpStatsPath: sftp.statsPath,
                    },
                    "SFTP-настройки сохранены",
                  )
                }
              >
                Сохранить
              </Button>
              <Button
                busy={busy}
                onClick={() =>
                  void runAction(async () => {
                    const res = await syncStats();
                    if (res) toast.info(`Статистика обновлена: ${res.updated} записей`);
                  }, "Синхронизация запущена")
                }
              >
                Синхронизировать статистику
              </Button>
              <Button
                variant="danger"
                busy={busy}
                onClick={() =>
                  void runAction(() => api.resetSftpFingerprint(), "Отпечаток сброшен (trust-on-first-use)")
                }
              >
                Сбросить отпечаток хоста
              </Button>
            </FormActions>
          </Form>
        </Panel>

        <Panel title="Бэкапы" description="S3-совместимое хранилище + шифрование.">
          <Form>
            <Field label="Endpoint">
              <Input value={backupForm.endpoint} onChange={(e) => setBackupForm((s) => ({ ...s, endpoint: e.target.value }))} className="mono" />
            </Field>
            <Field label="Бакет">
              <Input value={backupForm.bucket} onChange={(e) => setBackupForm((s) => ({ ...s, bucket: e.target.value }))} className="mono" />
            </Field>
            <Field label="Регион">
              <Input value={backupForm.region} onChange={(e) => setBackupForm((s) => ({ ...s, region: e.target.value }))} />
            </Field>
            <Field label="Префикс">
              <Input value={backupForm.prefix} onChange={(e) => setBackupForm((s) => ({ ...s, prefix: e.target.value }))} className="mono" />
            </Field>
            <Field
              label="Access key"
              hint={settings.backupAccessKeySet ? "Задан. Пусто — не менять." : "Ещё не задан"}
            >
              <Input value={backupForm.accessKey} onChange={(e) => setBackupForm((s) => ({ ...s, accessKey: e.target.value }))} autoComplete="off" />
            </Field>
            <Field label="Secret key" hint={settings.backupSecretKeySet ? "Задан." : "Ещё не задан"}>
              <Input type="password" value={backupForm.secretKey} onChange={(e) => setBackupForm((s) => ({ ...s, secretKey: e.target.value }))} autoComplete="new-password" />
            </Field>
            <Field label="Пароль шифрования" hint={settings.backupPasswordSet ? "Задан." : "Ещё не задан"} wide>
              <Input type="password" value={backupForm.password} onChange={(e) => setBackupForm((s) => ({ ...s, password: e.target.value }))} autoComplete="new-password" />
            </Field>
            <FormActions>
              <Button
                busy={busy}
                onClick={() =>
                  save(
                    {
                      backupEndpoint: backupForm.endpoint,
                      backupBucket: backupForm.bucket,
                      backupRegion: backupForm.region,
                      backupPrefix: backupForm.prefix,
                      ...(backupForm.accessKey ? { backupAccessKey: backupForm.accessKey } : {}),
                      ...(backupForm.secretKey ? { backupSecretKey: backupForm.secretKey } : {}),
                      ...(backupForm.password ? { backupPassword: backupForm.password } : {}),
                    },
                    "Настройки бэкапа сохранены",
                  )
                }
              >
                Сохранить
              </Button>
              <Button busy={busy} onClick={() => void runAction(() => api.runBackup(), "Бэкап запущен")}>
                Запустить бэкап
              </Button>
            </FormActions>
            <BackupStatusRow backup={backup} />
          </Form>
        </Panel>
      </div>

      <div className="page-stack">
        <Panel title="Интеграции">
          <Form>
            <Field label="GitHub-токен" hint={settings.githubTokenSet ? "Задан." : "Не задан: релизы и CI-прогоны недоступны"}>
              <Input type="password" value={githubToken} onChange={(e) => setGithubToken(e.target.value)} autoComplete="off" />
            </Field>
            <FormActions>
              <Button
                busy={busy}
                disabled={!githubToken.trim()}
                onClick={() => {
                  const token = githubToken;
                  setGithubToken("");
                  return save({ githubToken: token }, "GitHub-токен сохранён");
                }}
              >
                Сохранить
              </Button>
            </FormActions>

            <Field label="Ключ CurseForge" hint={settings.curseforgeApiKeySet ? "Задан." : "Не задан: поиск CurseForge недоступен"}>
              <Input type="password" value={curseforgeKey} onChange={(e) => setCurseforgeKey(e.target.value)} autoComplete="off" />
            </Field>
            <FormActions>
              <Button
                busy={busy}
                disabled={!curseforgeKey.trim()}
                onClick={() => {
                  const key = curseforgeKey;
                  setCurseforgeKey("");
                  return save({ curseforgeApiKey: key }, "Ключ CurseForge сохранён");
                }}
              >
                Сохранить
              </Button>
            </FormActions>

            <Field label="Награда за ачивку (монеты)">
              <Input
                type="number"
                min={0}
                value={coinReward}
                onChange={(e) => setCoinReward(e.target.value)}
              />
            </Field>
            <FormActions>
              <Button
                busy={busy}
                onClick={() => save({ achievementCoinReward: Number(coinReward) || 0 }, "Награда обновлена")}
              >
                Сохранить
              </Button>
            </FormActions>
          </Form>
        </Panel>

        <Panel title="AI-анализ крашей" description="OpenAI-совместимый провайдер для диагностики логов.">
          <Form>
            <div className="field-wide">
              <Switch
                checked={crashAi.enabled}
                onChange={(v) => setCrashAi((s) => ({ ...s, enabled: v }))}
                label="Включить анализ"
              />
            </div>
            <Field label="Endpoint" hint="Базовый URL, например https://api.openai.com/v1">
              <Input value={crashAi.endpoint} onChange={(e) => setCrashAi((s) => ({ ...s, endpoint: e.target.value }))} className="mono" />
            </Field>
            <Field label="Модель">
              <Input value={crashAi.model} onChange={(e) => setCrashAi((s) => ({ ...s, model: e.target.value }))} className="mono" />
            </Field>
            <Field label="API-ключ" hint={settings.crashAiApiKeySet ? "Задан." : "Ещё не задан"} wide>
              <Input type="password" value={crashAi.apiKey} onChange={(e) => setCrashAi((s) => ({ ...s, apiKey: e.target.value }))} autoComplete="off" />
            </Field>
            <FormActions>
              <Button
                busy={busy}
                onClick={() =>
                  save(
                    {
                      crashAiEnabled: crashAi.enabled,
                      crashAiEndpoint: crashAi.endpoint,
                      crashAiModel: crashAi.model,
                      ...(crashAi.apiKey ? { crashAiApiKey: crashAi.apiKey } : {}),
                    },
                    "Настройки AI сохранены",
                  )
                }
              >
                Сохранить
              </Button>
              <Button
                busy={busy}
                onClick={() =>
                  void runAction(async () => {
                    const res = await api.testCrashAi();
                    toast.success(`Провайдер отвечает, модель ${res.model}`);
                  }, "")
                }
              >
                Проверить
              </Button>
            </FormActions>
          </Form>
        </Panel>

        <TelemetryTokenPanel />
      </div>
    </div>
  );
}

function BackupStatusRow({ backup }: { backup: BackupStatus }) {
  const state = backup.state ?? backup.status ?? "idle";
  const tone = state === "success" ? "ok" : state === "error" ? "err" : state === "running" ? "info" : "neutral";
  return (
    <div className="field-wide row" style={{ gap: "var(--s3)" }}>
      <Chip tone={tone}>{state}</Chip>
      {backup.lastRunAt && (
        <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
          Последний запуск: {formatDateTime(backup.lastRunAt)}
        </span>
      )}
      {backup.error && <span className="text-err" style={{ fontSize: "var(--fs-xs)" }}>{backup.error}</span>}
    </div>
  );
}

function TelemetryTokenPanel() {
  const toast = useToast();
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Panel
      title="Токен телеметрии"
      description="Прописывается на Minecraft-сервере для отправки метрик."
      actions={
        <Button
          size="sm"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setToken((await api.generateServerTelemetryToken()).token);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Не удалось сгенерировать");
            } finally {
              setBusy(false);
            }
          }}
        >
          Сгенерировать новый
        </Button>
      }
    >
      {token ? (
        <div className="row">
          <span className="mono ellipsis" title={token}>{token}</span>
          <CopyButton text={token} label="Копировать токен" />
        </div>
      ) : (
        <p className="muted" style={{ fontSize: "var(--fs-sm)" }}>
          Токен показывается один раз после генерации — сразу скопируйте его.
        </p>
      )}
    </Panel>
  );
}

export default SettingsPage;
