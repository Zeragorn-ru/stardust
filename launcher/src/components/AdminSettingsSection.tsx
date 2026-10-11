import { useState } from "react";
import type { Settings } from "../types";
import { setBetaUpdates } from "../api";

type Props = {
  settings: Settings;
  onChange: (settings: Settings) => void;
};

/** Настройки, доступные только администраторам. */
export default function AdminSettingsSection({ settings, onChange }: Props) {
  const [betaError, setBetaError] = useState<string | null>(null);

  // Бета-канал пишем отдельной командой (set_beta_updates), а не через
  // автосохранение общих настроек: переключатель должен применяться сразу.
  async function handleBetaToggle() {
    const next = !settings.betaUpdates;
    setBetaError(null);
    onChange({ ...settings, betaUpdates: next });
    try {
      await setBetaUpdates(next);
    } catch (e) {
      // Не сохранилось — откатываем переключатель в исходное положение.
      setBetaError(e instanceof Error ? e.message : String(e));
      onChange({ ...settings, betaUpdates: !next });
    }
  }

  return (
    <div className="settings__body stagger">
      <div className="toggle-row stagger-item">
        <div className="toggle-row__text">
          <span className="toggle-row__title">Пропускать проверку сборки</span>
          <span className="muted toggle-row__desc">
            Запускать локальную сборку без синхронизации с сервером. Все моды,
            включая сторонние и StarDust, останутся включены.
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="Пропускать проверку сборки"
          aria-checked={settings.skipBuildCheck}
          className={"switch" + (settings.skipBuildCheck ? " switch--on" : "")}
          onClick={() => onChange({ ...settings, skipBuildCheck: !settings.skipBuildCheck })}
        >
          <span className="switch__knob" />
        </button>
      </div>

      <div className="toggle-row stagger-item">
        <div className="toggle-row__text">
          <span className="toggle-row__title">Бета-тестирование</span>
          <span className="muted toggle-row__desc">
            Устанавливать предварительные (pre-release) версии лаунчера
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="Бета-тестирование"
          aria-checked={settings.betaUpdates}
          className={"switch" + (settings.betaUpdates ? " switch--on" : "")}
          onClick={() => void handleBetaToggle()}
        >
          <span className="switch__knob" />
        </button>
      </div>

      {betaError && <div className="alert alert--error">Не удалось сохранить: {betaError}</div>}
    </div>
  );
}
