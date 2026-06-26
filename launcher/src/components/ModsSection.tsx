import { useEffect, useState } from "react";
import type { OptionalMod } from "../types";
import { listOptionalMods, setModEnabled } from "../api";

// Человекочитаемый размер файла.
function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

export default function ModsSection() {
  const [mods, setMods] = useState<OptionalMod[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // modId-ы, по которым идёт переключение (блокируем повторные клики).
  const [pending, setPending] = useState<Set<string>>(new Set());

  useEffect(() => {
    listOptionalMods()
      .then(setMods)
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function toggle(mod: OptionalMod) {
    const next = !mod.enabled;
    // Оптимистично обновляем UI.
    setMods((prev) =>
      prev
        ? prev.map((m) => (m.modId === mod.modId ? { ...m, enabled: next } : m))
        : prev,
    );
    setPending((prev) => new Set(prev).add(mod.modId));
    try {
      await setModEnabled(mod.modId, next);
    } catch {
      // Откатываем при ошибке.
      setMods((prev) =>
        prev
          ? prev.map((m) =>
              m.modId === mod.modId ? { ...m, enabled: mod.enabled } : m,
            )
          : prev,
      );
    } finally {
      setPending((prev) => {
        const copy = new Set(prev);
        copy.delete(mod.modId);
        return copy;
      });
    }
  }

  if (loadError) {
    return (
      <div className="mods-section">
        <p className="muted">Не удалось загрузить список модов: {loadError}</p>
      </div>
    );
  }

  if (!mods) {
    return (
      <div className="mods-section">
        <p className="muted">Загрузка списка модов…</p>
      </div>
    );
  }

  if (mods.length === 0) {
    return (
      <div className="mods-section">
        <p className="muted">
          В активной сборке нет дополнительных модов для настройки.
        </p>
      </div>
    );
  }

  return (
    <div className="mods-section">
      <p className="muted mods-section__hint">
        Дополнительные моды устанавливаются вместе со сборкой. Выключенные не
        загружаются игрой — включение применится при следующем запуске.
      </p>
      {mods.map((mod) => {
        const busy = pending.has(mod.modId);
        return (
          <div className="toggle-row" key={mod.modId}>
            <div className="toggle-row__text">
              <span className="toggle-row__title">
                {mod.name}
                {mod.size > 0 && (
                  <span className="muted mods-section__size">
                    {" "}
                    · {formatSize(mod.size)}
                  </span>
                )}
              </span>
              {mod.description && (
                <span className="muted toggle-row__desc">{mod.description}</span>
              )}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={mod.enabled}
              disabled={busy}
              className={"switch" + (mod.enabled ? " switch--on" : "")}
              onClick={() => toggle(mod)}
            >
              <span className="switch__knob" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
