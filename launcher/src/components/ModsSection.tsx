import { useEffect, useState } from "react";
import type { OptionalMod } from "../types";
import { listOptionalMods, setModEnabled } from "../api";
import { formatBytes } from "../format";

export default function ModsSection() {
  const [mods, setMods] = useState<OptionalMod[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
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
        <div className="settings__loading">
          <div className="spinner" />
          <span className="muted">Загрузка списка модов…</span>
        </div>
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

  const q = filter.trim().toLowerCase();
  const filtered = q
    ? mods.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          (m.description && m.description.toLowerCase().includes(q)),
      )
    : mods;

  return (
    <div className="mods-section stagger">
      <p className="muted mods-section__hint stagger-item">
        Дополнительные моды устанавливаются вместе со сборкой. Выключенные не
        загружаются игрой — включение применится при следующем запуске.
      </p>
      {mods.length > 0 && (
        <input
          type="text"
          className="input mods-section__filter"
          placeholder="Поиск модов…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}
      {filtered.map((mod) => {
        const busy = pending.has(mod.modId);
        return (
          <div className="toggle-row stagger-item" key={mod.modId}>
            <div className="toggle-row__text">
              <span className="toggle-row__title">
                {mod.name}
                {mod.size > 0 && (
                  <span className="muted mods-section__size">
                    {" "}
                    · {formatBytes(mod.size)}
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
