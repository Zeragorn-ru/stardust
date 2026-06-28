import { useEffect, useState } from "react";
import type { AppInfo, PlayerProfile, Settings, UpdateInfo } from "../types";
import {
  checkUpdate,
  getAppInfo,
  getSettings,
  installUpdate,
  onUpdateProgress,
  openPath,
  saveSettings,
} from "../api";
import { useMotion } from "../motion";
import AccountSection from "./AccountSection";
import ModsSection from "./ModsSection";

type Section = "general" | "account" | "mods";

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
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [saving, setSaving] = useState(false);

  // Состояние самообновления.
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "installing" | "error"
  >("idle");
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateProgress, setUpdateProgress] = useState<number | null>(null);

  useEffect(() => {
    getSettings().then(setSettings);
    getAppInfo().then(setInfo);
  }, []);

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
    const unlisten = await onUpdateProgress(setUpdateProgress);
    try {
      // При успехе бэкенд перезапустит приложение — промис может не завершиться.
      await installUpdate();
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
      setUpdateStatus("error");
    } finally {
      unlisten();
    }
  }

  async function handleSave() {
    if (!settings) return;
    setSaving(true);
    try {
      await saveSettings(settings);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <div className="settings">
        <p className="muted">Загрузка настроек…</p>
      </div>
    );
  }

  return (
    <div className="settings">
      <header className="settings__header">
        <button className="btn btn--ghost" onClick={onClose}>
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
        </nav>

        {section === "account" ? (
          <div className="settings__body" key="account">
            <AccountSection
              profile={profile}
              onProfileChange={onProfileChange}
              onAccountDeleted={onAccountDeleted}
            />
          </div>
        ) : section === "mods" ? (
          <div className="settings__body" key="mods">
            <ModsSection />
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
                    {update.notes ? `: ${update.notes}` : "."}
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
                    Загрузка обновления…
                    {updateProgress != null &&
                      ` ${Math.round(updateProgress * 100)}%`}
                  </p>
                  <div className="progress">
                    <div className="progress__track">
                      <div
                        className="progress__bar"
                        style={{
                          width:
                            updateProgress != null
                              ? `${Math.round(updateProgress * 100)}%`
                              : "100%",
                        }}
                      />
                    </div>
                  </div>
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
    </div>
  );
}
