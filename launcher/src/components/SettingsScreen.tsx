import { useEffect, useState } from "react";
import type { AppInfo, PlayerProfile, Settings, UpdateInfo, UpdateProgress } from "../types";
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

  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s);
      setInitialSettings(s);
    });
    getAppInfo().then(setInfo);
  }, []);

  // Проверка несохранённых изменений.
  const isDirty =
    settings != null &&
    initialSettings != null &&
    (settings.memoryMb !== initialSettings.memoryMb ||
      settings.downloadConcurrency !== initialSettings.downloadConcurrency ||
      settings.show3dModel !== initialSettings.show3dModel ||
      settings.proxyType !== initialSettings.proxyType);

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
              onClick={() => setSettings({ memoryMb: 4096, downloadConcurrency: 6, show3dModel: true, proxyType: "builtin" })}
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
    </div>
  );
}
