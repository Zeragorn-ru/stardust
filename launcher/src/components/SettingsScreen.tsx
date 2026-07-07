import { useEffect, useState } from "react";
import type { AppInfo, JavaInstallation, JavaProvider, JavaVendorInfo, LogPaths, PlayerProfile, Progress, Settings, UpdateInfo, UpdateProgress } from "../types";
import {
  checkUpdate,
  downloadJava,
  getAppInfo,
  getLogPaths,
  getSettings,
  installUpdate,
  listJavaDownloadVendors,
  listJavaInstallations,
  listJavaInstallationsDeep,
  onLauncherProgress,
  onUpdateProgress,
  openLogFolder,
  openPath,
  saveSettings,
} from "../api";
import { useMotion } from "../motion";
import AccountSection from "./AccountSection";
import LogViewerModal, { type LogTab } from "./LogViewerModal";
import ModsSection from "./ModsSection";

type Section = "general" | "account" | "mods" | "logs";

interface Props {
  profile: PlayerProfile | null;
  onProfileChange: (profile: PlayerProfile) => void;
  onAccountDeleted: () => void;
  initialSection?: Section;
  onClose: () => void;
}

// Разумные границы выделяемой памяти (МБ).
const MEM_MIN = 1024;
const MEM_MAX = 16384;
const MEM_STEP = 512;

// Границы параллельности загрузок (одновременных файлов).
const DL_MIN = 1;
const DL_MAX = 16;

/** Форматирование скорости загрузки. */
function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} Б/с`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} КБ/с`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} МБ/с`;
}

/** Форматирование ETA. */
function formatEta(seconds: number): string {
  if (seconds < 60) return `~${Math.round(seconds)}с`;
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return sec > 0 ? `~${min}м ${sec}с` : `~${min}м`;
}

const JAVA_PROVIDER_LABELS: Record<JavaProvider, string> = {
  auto: "Авто",
  temurin: "Temurin (лаунчер)",
  system: "Системная",
  custom: "Свой путь",
};

export default function SettingsScreen({
  profile,
  onProfileChange,
  onAccountDeleted,
  initialSection = "general",
  onClose,
}: Props) {
  const { animations, setAnimations } = useMotion();
  const [section, setSection] = useState<Section>(initialSection);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [initialSettings, setInitialSettings] = useState<Settings | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [saving, setSaving] = useState(false);

  // Состояние самообновления.
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "installing" | "error"
  >("idle");
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);

  const [javaInstalls, setJavaInstalls] = useState<JavaInstallation[] | null>(null);
  const [javaVendors, setJavaVendors] = useState<JavaVendorInfo[]>([]);
  const [javaListError, setJavaListError] = useState<string | null>(null);
  const [javaRefreshing, setJavaRefreshing] = useState(false);
  const [javaDeepSearching, setJavaDeepSearching] = useState(false);
  const [javaDownloading, setJavaDownloading] = useState(false);
  const [downloadingVendor, setDownloadingVendor] = useState<string | null>(null);
  const [javaDownloadError, setJavaDownloadError] = useState<string | null>(null);
  const [javaProgress, setJavaProgress] = useState<Progress | null>(null);

  const [logPaths, setLogPaths] = useState<LogPaths | null>(null);
  const [logViewer, setLogViewer] = useState<{
    title: string;
    tabs: LogTab[];
    initialTabId?: string;
  } | null>(null);

  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s);
      setInitialSettings(s);
    });
    getAppInfo().then(setInfo);
    listJavaDownloadVendors().then(setJavaVendors);
    getLogPaths().then(setLogPaths).catch(() => undefined);
  }, []);

  async function refreshJavaList(deep = false) {
    if (deep) {
      setJavaDeepSearching(true);
    } else {
      setJavaRefreshing(true);
    }
    setJavaListError(null);
    try {
      const list = deep
        ? await listJavaInstallationsDeep()
        : await listJavaInstallations();
      setJavaInstalls(list);
    } catch (e) {
      setJavaListError(e instanceof Error ? e.message : String(e));
    } finally {
      setJavaRefreshing(false);
      setJavaDeepSearching(false);
    }
  }

  useEffect(() => {
    if (section === "general") {
      void refreshJavaList();
    }
  }, [section]);

  // Проверка несохранённых изменений.
  const isDirty =
    settings != null &&
    initialSettings != null &&
    (settings.memoryMb !== initialSettings.memoryMb ||
      settings.downloadConcurrency !== initialSettings.downloadConcurrency ||
      settings.show3dModel !== initialSettings.show3dModel ||
      settings.proxyType !== initialSettings.proxyType ||
      (settings.javaProvider ?? "auto") !== (initialSettings.javaProvider ?? "auto") ||
      (settings.javaCustomPath ?? "") !== (initialSettings.javaCustomPath ?? ""));

  function handleClose() {
    if (isDirty && !window.confirm("Есть несохранённые изменения. Покинуть настройки?")) {
      return;
    }
    onClose();
  }

  async function handleCheckUpdate() {
    setUpdateStatus("checking");
    setUpdateError(null);
    try {
      const result = await checkUpdate();
      setUpdate(result);
      setUpdateStatus("idle");
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
      setUpdateStatus("error");
    }
  }

  async function handleInstallUpdate() {
    setUpdateStatus("installing");
    setUpdateError(null);
    setUpdateProgress(null);
    const unlisten = await onUpdateProgress((p) => {
      setUpdateProgress(p);
      if (p.phase === "error") {
        setUpdateError(p.label);
        setUpdateStatus("error");
      }
    });
    try {
      await installUpdate();
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
      setUpdateStatus("error");
    } finally {
      unlisten();
    }
  }

  async function handleDeepJavaSearch() {
    if (
      !window.confirm(
        "Глубокий поиск может занять некоторое время. Продолжить?",
      )
    ) {
      return;
    }
    await refreshJavaList(true);
  }

  async function handleDownloadJava(vendorId: string) {
    setJavaDownloading(true);
    setDownloadingVendor(vendorId);
    setJavaDownloadError(null);
    setJavaProgress(null);
    const unlisten = await onLauncherProgress((p) => {
      setJavaProgress(p);
    });
    try {
      const path = await downloadJava(vendorId);
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              javaProvider: "custom",
              javaCustomPath: path,
            }
          : prev,
      );
      await refreshJavaList(false);
    } catch (e) {
      setJavaDownloadError(e instanceof Error ? e.message : String(e));
    } finally {
      unlisten();
      setJavaDownloading(false);
      setDownloadingVendor(null);
      setJavaProgress(null);
    }
  }

  function selectJavaInstall(install: JavaInstallation) {
    setSettings((prev) =>
      prev
        ? {
            ...prev,
            javaProvider: "custom",
            javaCustomPath: install.path,
          }
        : prev,
    );
  }

  async function handleSave() {
    if (!settings) return;
    setSaving(true);
    try {
      await saveSettings(settings);
      setInitialSettings(settings);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <div className="settings">
        <div className="settings__loading">
          <div className="spinner" />
          <span className="muted">Загрузка настроек…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="settings">
      <header className="settings__header">
        <button className="btn btn--ghost" onClick={handleClose}>
          ← Назад
        </button>
        <h2>Настройки</h2>
        {section === "general" && (
          <button
            className="btn btn--primary settings__header-save"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Сохранение…" : "Сохранить"}
          </button>
        )}
      </header>

      <div className="settings__layout">
        <nav className="settings__nav">
          <button
            type="button"
            className={
              "settings__nav-item" +
              (section === "general" ? " settings__nav-item--active" : "")
            }
            onClick={() => setSection("general")}
          >
            Общие
          </button>
          <button
            type="button"
            className={
              "settings__nav-item" +
              (section === "account" ? " settings__nav-item--active" : "")
            }
            onClick={() => setSection("account")}
          >
            Аккаунт
          </button>
          <button
            type="button"
            className={
              "settings__nav-item" +
              (section === "mods" ? " settings__nav-item--active" : "")
            }
            onClick={() => setSection("mods")}
          >
            Сборка
          </button>
          <button
            type="button"
            className={
              "settings__nav-item" +
              (section === "logs" ? " settings__nav-item--active" : "")
            }
            onClick={() => setSection("logs")}
          >
            Логи
          </button>
        </nav>

        {section === "account" ? (
          <div className="settings__body stagger" key="account">
            <AccountSection
              profile={profile}
              onProfileChange={onProfileChange}
              onAccountDeleted={onAccountDeleted}
            />
          </div>
        ) : section === "mods" ? (
          <div className="settings__body stagger" key="mods">
            <ModsSection />
          </div>
        ) : section === "logs" ? (
          <div className="settings__body stagger" key="logs">
            <div className="logs-card stagger-item">
              <div className="toggle-row__text">
                <span className="toggle-row__title">Логи лаунчера</span>
                <span className="muted toggle-row__desc">
                  Диагностика запуска, загрузок и ошибок лаунчера.
                </span>
              </div>
              <div className="logs-card__actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!logPaths}
                  onClick={() =>
                    logPaths &&
                    setLogViewer({
                      title: "Лог лаунчера",
                      tabs: [
                        {
                          id: "launcher",
                          label: "launcher.log",
                          path: logPaths.launcherLogLatest,
                        },
                      ],
                    })
                  }
                >
                  Лог лаунчера
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!logPaths}
                  onClick={() => void openLogFolder("launcherLogs")}
                >
                  Открыть папку
                </button>
              </div>
            </div>

            <div className="logs-card stagger-item">
              <div className="toggle-row__text">
                <span className="toggle-row__title">Логи Minecraft</span>
                <span className="muted toggle-row__desc">
                  latest.log и debug.log из папки игры.
                </span>
              </div>
              <div className="logs-card__actions">
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!logPaths}
                  onClick={() =>
                    logPaths &&
                    setLogViewer({
                      title: "Лог игры",
                      tabs: [
                        {
                          id: "latest",
                          label: "latest.log",
                          path: logPaths.minecraftLatestLog,
                        },
                      ],
                    })
                  }
                >
                  Лог игры (latest.log)
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!logPaths}
                  onClick={() =>
                    logPaths &&
                    setLogViewer({
                      title: "Отладочный лог",
                      tabs: [
                        {
                          id: "debug",
                          label: "debug.log",
                          path: logPaths.minecraftDebugLog,
                        },
                      ],
                    })
                  }
                >
                  Отладочный лог
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={!logPaths}
                  onClick={() => void openLogFolder("minecraftLogs")}
                >
                  Открыть папку
                </button>
              </div>
            </div>

            <div className="logs-card stagger-item">
              <div className="toggle-row__text">
                <span className="toggle-row__title">Подробные логи</span>
                <span className="muted toggle-row__desc">
                  Лаунчер и оба лога Minecraft в одном окне.
                </span>
              </div>
              <div className="logs-card__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!logPaths}
                  onClick={() =>
                    logPaths &&
                    setLogViewer({
                      title: "Подробные логи",
                      tabs: [
                        {
                          id: "launcher",
                          label: "Лаунчер",
                          path: logPaths.launcherLogLatest,
                        },
                        {
                          id: "latest",
                          label: "latest.log",
                          path: logPaths.minecraftLatestLog,
                        },
                        {
                          id: "debug",
                          label: "debug.log",
                          path: logPaths.minecraftDebugLog,
                        },
                      ],
                      initialTabId: "launcher",
                    })
                  }
                >
                  Все логи
                </button>
              </div>
            </div>

            {logPaths?.crashReportsExists && (
              <div className="logs-card stagger-item">
                <div className="toggle-row__text">
                  <span className="toggle-row__title">Crash reports</span>
                  <span className="muted toggle-row__desc">
                    Отчёты о сбоях Minecraft.
                  </span>
                </div>
                <div className="logs-card__actions">
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void openLogFolder("crashReports")}
                  >
                    Открыть папку
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="settings__body stagger" key="general">
            <div className="update-card stagger-item">
              <div className="update-card__head">
                <span className="toggle-row__title">Обновления</span>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={handleCheckUpdate}
                  disabled={
                    updateStatus === "checking" || updateStatus === "installing"
                  }
                >
                  {updateStatus === "checking"
                    ? "Проверка…"
                    : "Проверить обновления"}
                </button>
              </div>

              {updateStatus === "error" && updateError && (
                <p className="muted update-card__msg">Ошибка: {updateError}</p>
              )}

              {update && update.available && updateStatus !== "installing" && (
                <div className="update-card__available">
                  <p className="update-card__msg">
                    Доступна версия <strong>{update.version}</strong>
                    {update.notes ? `: ${update.notes}` : ""}
                  </p>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={handleInstallUpdate}
                  >
                    Обновить и перезапустить
                  </button>
                </div>
              )}

              {update && !update.available && updateStatus === "idle" && (
                <p className="muted update-card__msg">
                  Установлена последняя версия.
                </p>
              )}

              {updateStatus === "installing" && (
                <div className="update-card__progress">
                  <p className="muted update-card__msg">
                    {updateProgress?.label ?? "Загрузка обновления…"}
                    {Number.isFinite(updateProgress?.fraction) &&
                      ` ${Math.round(updateProgress!.fraction! * 100)}%`}
                  </p>
                  <div className="progress">
                    <div className="progress__track">
                      <div
                        className={
                          "progress__bar" +
                          (!Number.isFinite(updateProgress?.fraction)
                            ? " progress__bar--indeterminate"
                            : "")
                        }
                        style={{
                          width: Number.isFinite(updateProgress?.fraction)
                            ? `${Math.round(updateProgress!.fraction! * 100)}%`
                            : undefined,
                        }}
                      />
                    </div>
                  </div>
                  {Number.isFinite(updateProgress?.speedBytesPerSec) &&
                    updateProgress!.speedBytesPerSec! > 0 && (
                      <p className="muted update-card__msg">
                        {formatSpeed(updateProgress!.speedBytesPerSec!)}
                        {Number.isFinite(updateProgress?.etaSeconds) &&
                          updateProgress!.etaSeconds! > 0 &&
                          ` · ${formatEta(updateProgress!.etaSeconds!)}`}
                      </p>
                    )}
                </div>
              )}
            </div>

            <div className="field stagger-item">
              <span>
                Память: <strong>{settings.memoryMb} МБ</strong>
              </span>
              <div className="range-row">
                <button
                  type="button"
                  className="btn btn--stepper"
                  onClick={() => setSettings({ ...settings, memoryMb: Math.max(MEM_MIN, settings.memoryMb - MEM_STEP) })}
                >−</button>
                <input
                  type="range"
                  min={MEM_MIN}
                  max={MEM_MAX}
                  step={MEM_STEP}
                  value={settings.memoryMb}
                  onChange={(e) =>
                    setSettings({ ...settings, memoryMb: Number(e.target.value) })
                  }
                />
                <button
                  type="button"
                  className="btn btn--stepper"
                  onClick={() => setSettings({ ...settings, memoryMb: Math.min(MEM_MAX, settings.memoryMb + MEM_STEP) })}
                >+</button>
              </div>
              <div className="range-bounds muted">
                <span>{MEM_MIN} МБ</span>
                <span>{MEM_MAX} МБ</span>
              </div>
            </div>

            <div className="field stagger-item">
              <span>
                Одновременных загрузок:{" "}
                <strong>{settings.downloadConcurrency}</strong>
              </span>
              <input
                type="range"
                min={DL_MIN}
                max={DL_MAX}
                step={1}
                value={settings.downloadConcurrency}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    downloadConcurrency: Number(e.target.value),
                  })
                }
              />
              <div className="range-bounds muted">
                <span>{DL_MIN}</span>
                <span>{DL_MAX}</span>
              </div>
            </div>

            {settings && (
              <div className="java-card stagger-item">
                <div className="java-card__head">
                  <div className="toggle-row__text">
                    <span className="toggle-row__title">Java</span>
                    <span className="muted toggle-row__desc">
                      Minecraft 1.21 требует Java 21+. Выберите источник или укажите путь к
                      исполняемому файлу.
                    </span>
                  </div>
                  <div className="java-card__head-actions">
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => void refreshJavaList(false)}
                      disabled={javaRefreshing || javaDeepSearching}
                    >
                      {javaRefreshing ? "Поиск…" : "Обновить список"}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => void handleDeepJavaSearch()}
                      disabled={javaRefreshing || javaDeepSearching || javaDownloading}
                    >
                      {javaDeepSearching ? "Глубокий поиск…" : "Глубокий поиск"}
                    </button>
                  </div>
                </div>

                <div className="field">
                  <span>Источник Java</span>
                  <select
                    value={settings.javaProvider ?? "auto"}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        javaProvider: e.target.value as JavaProvider,
                      })
                    }
                  >
                    <option value="auto">{JAVA_PROVIDER_LABELS.auto} (Temurin → система → скачать)</option>
                    <option value="temurin">{JAVA_PROVIDER_LABELS.temurin}</option>
                    <option value="system">{JAVA_PROVIDER_LABELS.system}</option>
                    <option value="custom">{JAVA_PROVIDER_LABELS.custom}</option>
                  </select>
                </div>

                {(settings.javaProvider ?? "auto") === "custom" && (
                  <div className="field">
                    <span>Путь к java</span>
                    <input
                      type="text"
                      className="input"
                      placeholder="/path/to/java или C:\Program Files\...\bin\java.exe"
                      value={settings.javaCustomPath ?? ""}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          javaCustomPath: e.target.value || null,
                        })
                      }
                    />
                  </div>
                )}

                <div className="java-card__download">
                  <span className="toggle-row__title">Скачать Java 21</span>
                  <div className="java-vendors">
                    {javaVendors.map((vendor) => (
                      <button
                        key={vendor.id}
                        type="button"
                        className="java-vendors__item"
                        onClick={() => void handleDownloadJava(vendor.id)}
                        disabled={javaDownloading}
                      >
                        <span className="java-vendors__name">{vendor.name}</span>
                        <span className="muted java-vendors__label">{vendor.label}</span>
                        {downloadingVendor === vendor.id && (
                          <span className="muted java-vendors__status">Скачивание…</span>
                        )}
                      </button>
                    ))}
                  </div>
                  {javaDownloading && javaProgress && (
                    <p className="muted java-card__msg">
                      {javaProgress.label}
                      {Number.isFinite(javaProgress.fraction) &&
                        ` ${Math.round(javaProgress.fraction! * 100)}%`}
                    </p>
                  )}
                </div>

                {javaDownloadError && (
                  <p className="muted java-card__msg">Ошибка скачивания: {javaDownloadError}</p>
                )}
                {javaListError && (
                  <p className="muted java-card__msg">Ошибка поиска: {javaListError}</p>
                )}

                {javaInstalls === null && !javaListError && (
                  <p className="muted java-card__msg">Ищем установки Java…</p>
                )}

                {javaInstalls && javaInstalls.length === 0 && (
                  <p className="muted java-card__msg">
                    Java 21+ не найдена. Скачайте Temurin или укажите путь вручную.
                  </p>
                )}

                {javaInstalls && javaInstalls.length > 0 && (
                  <div className="java-list">
                    {javaInstalls.map((install) => {
                      const selected =
                        (settings.javaProvider ?? "auto") === "custom" &&
                        settings.javaCustomPath === install.path;
                      return (
                        <button
                          key={`${install.path}-${install.source}`}
                          type="button"
                          className={
                            "java-list__item" + (selected ? " java-list__item--selected" : "")
                          }
                          onClick={() => selectJavaInstall(install)}
                          title={install.path}
                        >
                          <span className="java-list__title">
                            Java {install.major}
                            <span className="muted"> · {install.version}</span>
                          </span>
                          <span className="muted java-list__source">{install.source}</span>
                          <span className="java-list__path">{install.path}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="toggle-row stagger-item">
              <div className="toggle-row__text">
                <span className="toggle-row__title">Анимации</span>
                <span className="muted toggle-row__desc">
                  Живой фон и плавные переходы. Отключите для экономии ресурсов.
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={animations}
                className={"switch" + (animations ? " switch--on" : "")}
                onClick={() => setAnimations(!animations)}
              >
                <span className="switch__knob" />
              </button>
            </div>

            {settings && (
              <div className="toggle-row stagger-item">
                <div className="toggle-row__text">
                  <span className="toggle-row__title">3D-модель скина</span>
                  <span className="muted toggle-row__desc">
                    Отключите для экономии ресурсов (плоская аватарка вместо 3D).
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.show3dModel}
                  className={"switch" + (settings.show3dModel ? " switch--on" : "")}
                  onClick={() => setSettings({ ...settings, show3dModel: !settings.show3dModel })}
                >
                  <span className="switch__knob" />
                </button>
              </div>
            )}

            {settings && (
              <div className="toggle-row stagger-item">
                <div className="toggle-row__text">
                  <span className="toggle-row__title">Прокси-сервер</span>
                  <span className="muted toggle-row__desc">
                    Использовать системные настройки, встроенный прокси или отключить его.
                  </span>
                </div>
                <select
                  value={settings.proxyType}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      proxyType: e.target.value as "system" | "builtin" | "none",
                    })
                  }
                >
                  <option value="system">Системный прокси</option>
                  <option value="builtin">Встроенный прокси</option>
                  <option value="none">Без прокси</option>
                </select>
              </div>
            )}

            <button
              type="button"
              className="btn btn--ghost stagger-item"
              onClick={() =>
                setSettings({
                  memoryMb: 4096,
                  downloadConcurrency: 6,
                  show3dModel: true,
                  proxyType: "builtin",
                  javaProvider: "auto",
                  javaCustomPath: null,
                })
              }
            >
              Сбросить настройки по умолчанию
            </button>

            {info && (
              <div className="info-card stagger-item">
                <div className="info-card__row">
                  <span className="muted">Режим</span>
                  <span className="badge">
                    {info.mode === "portable" ? "Портативный" : "Установленный"}
                  </span>
                </div>
                <div className="info-card__row">
                  <span className="muted">Папка exe</span>
                  <span
                    className="info-card__path info-card__path--link"
                    title={info.exeDir}
                    onClick={() => openPath(info.exeDir)}
                  >
                    {info.exeDir}
                  </span>
                </div>
                <div className="info-card__row">
                  <span className="muted">portable.txt</span>
                  <span className="badge">
                    {info.portableMarker ? "найден" : "не найден"}
                  </span>
                </div>
                <div className="info-card__row">
                  <span className="muted">Папка данных</span>
                  <span
                    className="info-card__path info-card__path--link"
                    title={info.dataDir}
                    onClick={() => openPath(info.dataDir)}
                  >
                    {info.dataDir}
                  </span>
                </div>
                <div className="info-card__row">
                  <span className="muted">Версия</span>
                  <span>{info.version}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {logViewer && (
        <LogViewerModal
          title={logViewer.title}
          tabs={logViewer.tabs}
          initialTabId={logViewer.initialTabId}
          onClose={() => setLogViewer(null)}
        />
      )}
    </div>
  );
}
