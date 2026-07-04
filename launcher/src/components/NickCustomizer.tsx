// Выбор бейджа и градиента для ника в лаунчере.
// Превью показывает как ник будет выглядеть в Minecraft.

import { useCallback, useEffect, useState } from "react";
import { getCustomization, setActiveCustomization } from "../api";
import type { PlayerCustomization } from "../types";

interface Props {
  onSaved?: () => void;
}

export default function NickCustomizer({ onSaved }: Props) {
  const [data, setData] = useState<PlayerCustomization | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedBadge, setSelectedBadge] = useState<number | null>(null);
  const [selectedGradient, setSelectedGradient] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await getCustomization();
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
    try {
      await setActiveCustomization(selectedBadge, selectedGradient);
      onSaved?.();
    } catch {
      // ignore
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
        <div className="nick-preview__name">
          {activeBadge && (
            <span className="nick-badge" style={{ color: activeBadge.color }}>
              {activeBadge.emoji}
            </span>
          )}
          <span
            className="nick-text"
            style={
              activeGradient
                ? {
                    background: `linear-gradient(90deg, ${activeGradient.colorStart}, ${activeGradient.colorEnd})`,
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                  }
                : undefined
            }
          >
            Notch
          </span>
        </div>
      </div>

      {/* Бейджи */}
      <div className="nick-section">
        <span className="nick-section__title">Бейдж</span>
        <div className="nick-badges">
          <button
            className={"nick-badge-btn" + (selectedBadge === null ? " selected" : "")}
            onClick={() => setSelectedBadge(null)}
            title="Без бейджа"
          >
            —
          </button>
          {data.availableBadges.map((b) => (
            <button
              key={b.id}
              className={"nick-badge-btn" + (selectedBadge === b.id ? " selected" : "")}
              onClick={() => setSelectedBadge(b.id)}
              title={b.label}
              style={{ borderColor: selectedBadge === b.id ? b.color : undefined }}
            >
              {b.emoji}
            </button>
          ))}
        </div>
      </div>

      {/* Градиенты */}
      <div className="nick-section">
        <span className="nick-section__title">Градиент</span>
        <div className="nick-gradients">
          <button
            className={"nick-gradient-btn" + (selectedGradient === null ? " selected" : "")}
            onClick={() => setSelectedGradient(null)}
          >
            Без градиента
          </button>
          {data.availableGradients.map((g) => (
            <button
              key={g.id}
              className={"nick-gradient-btn" + (selectedGradient === g.id ? " selected" : "")}
              onClick={() => setSelectedGradient(g.id)}
            >
              <span
                className="nick-gradient-swatch"
                style={{ background: `linear-gradient(90deg, ${g.colorStart}, ${g.colorEnd})` }}
              />
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {/* Сохранить */}
      <div className="nick-actions">
        <button className="btn btn--primary" onClick={handleSave} disabled={saving}>
          {saving ? "Сохранение…" : "Сохранить"}
        </button>
      </div>
    </div>
  );
}
