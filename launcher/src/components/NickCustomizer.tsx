// Выбор бейджа и градиента для ника в лаунчере.
// Превью показывает как ник будет выглядеть в Minecraft.

import { useCallback, useEffect, useState } from "react";
import { getCustomization, setActiveCustomization } from "../api";
import type { PlayerCustomization } from "../types";
import MinecraftNickname from "./MinecraftNickname";

interface Props {
  playerName: string;
  onSaved?: () => void;
}

type RawCustomization = PlayerCustomization & {
  available_badges?: PlayerCustomization["availableBadges"];
  available_gradients?: PlayerCustomization["availableGradients"];
  active_badge_id?: number | null;
  active_gradient_id?: number | null;
};

function normalizeCustomization(raw: RawCustomization): PlayerCustomization {
  return {
    availableBadges: raw.availableBadges ?? raw.available_badges ?? [],
    availableGradients: raw.availableGradients ?? raw.available_gradients ?? [],
    activeBadgeId: raw.activeBadgeId ?? raw.active_badge_id ?? null,
    activeGradientId: raw.activeGradientId ?? raw.active_gradient_id ?? null,
  };
}

export default function NickCustomizer({ playerName, onSaved }: Props) {
  const [data, setData] = useState<PlayerCustomization | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedBadge, setSelectedBadge] = useState<number | null>(null);
  const [selectedGradient, setSelectedGradient] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const c = normalizeCustomization(await getCustomization() as RawCustomization);
      setData(c);
      setSelectedBadge(c.activeBadgeId);
      setSelectedGradient(c.activeGradientId);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const activeBadge = data?.availableBadges.find((b) => b.id === selectedBadge) ?? null;
  const activeGradient = data?.availableGradients.find((g) => g.id === selectedGradient) ?? null;

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      await setActiveCustomization(selectedBadge, selectedGradient);
      setSaved(true);
      onSaved?.();
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="nick-loading muted"><span className="spinner" /> Загрузка…</div>;
  }

  if (!data) {
    return <div className="nick-loading muted">Не удалось загрузить данные</div>;
  }

  return (
    <div className="nick-customizer">
      {/* Превью */}
      <div className="nick-preview">
        <span className="nick-preview__label">Превью:</span>
        <MinecraftNickname
          className="nick-preview__name"
          name={playerName}
          badge={activeBadge}
          gradient={activeGradient}
        />
      </div>

      {/* Бейджи */}
      <div className="nick-section">
        <span className="nick-section__title">Бейдж</span>
        <div className="nick-badges">
          <button
            type="button"
            className={"nick-option-btn" + (selectedBadge === null ? " selected" : "")}
            onClick={() => setSelectedBadge(null)}
            title="Без бейджа"
            aria-pressed={selectedBadge === null}
          >
            <MinecraftNickname name={playerName} gradient={activeGradient} />
          </button>
          {data.availableBadges.map((b) => (
            <button
              key={b.id}
              type="button"
              className={"nick-option-btn" + (selectedBadge === b.id ? " selected" : "")}
              onClick={() => setSelectedBadge(b.id)}
              title={b.label}
              aria-pressed={selectedBadge === b.id}
              style={{ borderColor: selectedBadge === b.id ? b.color : undefined }}
            >
              <MinecraftNickname name={playerName} badge={b} gradient={activeGradient} />
              <span className="nick-option-label">{b.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Градиенты */}
      <div className="nick-section">
        <span className="nick-section__title">Градиент</span>
        <div className="nick-gradients">
          <button
            type="button"
            className={"nick-option-btn" + (selectedGradient === null ? " selected" : "")}
            onClick={() => setSelectedGradient(null)}
            aria-pressed={selectedGradient === null}
          >
            <MinecraftNickname name={playerName} badge={activeBadge} />
            <span className="nick-option-label">Без градиента</span>
          </button>
          {data.availableGradients.map((g) => (
            <button
              key={g.id}
              type="button"
              className={"nick-option-btn" + (selectedGradient === g.id ? " selected" : "")}
              onClick={() => setSelectedGradient(g.id)}
              aria-pressed={selectedGradient === g.id}
            >
              <span
                className="nick-gradient-swatch"
                style={{ background: `linear-gradient(90deg, ${g.colorStart}, ${g.colorEnd})` }}
              />
              <MinecraftNickname name={playerName} badge={activeBadge} gradient={g} />
              <span className="nick-option-label">{g.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Сохранить */}
      <div className="nick-actions">
        <button className={"btn" + (saved ? " btn--success" : " btn--primary")} onClick={handleSave} disabled={saving}>
          {saving ? "Сохранение…" : saved ? "✓ Сохранено" : "Сохранить"}
        </button>
      </div>
      {saveError && <div className="alert alert--error nick-save-error">{saveError}</div>}
    </div>
  );
}
