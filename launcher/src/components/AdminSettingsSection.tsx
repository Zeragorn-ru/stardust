import type { Settings } from "../types";

type Props = {
  settings: Settings;
  onChange: (settings: Settings) => void;
};

/** Настройки, доступные только администраторам. */
export default function AdminSettingsSection({ settings, onChange }: Props) {
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
    </div>
  );
}
