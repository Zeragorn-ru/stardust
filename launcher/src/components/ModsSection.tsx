import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModProfileInfo, OptionalMod } from "../types";
import {
  listModProfiles,
  listOptionalMods,
  setModEnabled,
  setModProfile,
} from "../api";
import { formatBytes } from "../format";

function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

export default function ModsSection() {
  const [mods, setMods] = useState<OptionalMod[] | null>(null);
  const [profiles, setProfiles] = useState<ModProfileInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  // modId-ы, по которым идёт переключение (блокируем повторные клики).
  const [pending, setPending] = useState<Set<string>>(new Set());
  // Ключ профиля, который сейчас переключается.
  const [pendingProfile, setPendingProfile] = useState<string | null>(null);

  const loadMods = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [list, profileList] = await Promise.all([
        listOptionalMods(),
        listModProfiles(),
      ]);
      setMods(list);
      setProfiles(profileList);
    } catch (e) {
      setMods(null);
      setProfiles(null);
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMods();
  }, [loadMods]);

  const byId = useMemo(() => {
    const map = new Map<string, OptionalMod>();
    for (const m of mods ?? []) {
      map.set(normalizeId(m.modId), m);
    }
    return map;
  }, [mods]);

  /** Активные конфликты для мода: включённые моды из conflictsWith. */
  function activeConflicts(mod: OptionalMod): OptionalMod[] {
    if (!mod.enabled) return [];
    const ids = mod.conflictsWith ?? [];
    return ids
      .map((id) => byId.get(normalizeId(id)))
      .filter((other): other is OptionalMod => other != null && other.enabled);
  }

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
      // Состояние профиля могло измениться — пересчитаем.
      void listModProfiles().then(setProfiles).catch(() => undefined);
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

  async function toggleProfile(profile: ModProfileInfo) {
    const next = !profile.active;
    // Снимок состояния модов профиля до переключения — для точного отката
    // (индивидуально выключенные моды не должны «включаться» при откате).
    const modsSnapshot = mods ?? [];
    // Оптимистично: помечаем профиль и все его моды.
    setPendingProfile(profile.key);
    setProfiles((prev) =>
      prev
        ? prev.map((p) => (p.key === profile.key ? { ...p, active: next } : p))
        : prev,
    );
    setMods((prev) =>
      prev
        ? prev.map((m) =>
            m.profiles.some((k) => k.toLowerCase() === profile.key.toLowerCase())
              ? { ...m, enabled: next }
              : m,
          )
        : prev,
    );
    try {
      await setModProfile(profile.key, next);
      // Перечитываем согласованное состояние с бэкенда.
      const [list, profileList] = await Promise.all([
        listOptionalMods(),
        listModProfiles(),
      ]);
      setMods(list);
      setProfiles(profileList);
    } catch {
      // Откат к снимку: каждый мод возвращается к своему значению.
      setMods(modsSnapshot);
      setProfiles((prev) =>
        prev
          ? prev.map((p) =>
              p.key === profile.key ? { ...p, active: profile.active } : p,
            )
          : prev,
      );
    } finally {
      setPendingProfile(null);
    }
  }

  if (loadError) {
    return (
      <div className="mods-section">
        <p className="muted">Не удалось загрузить список модов: {loadError}</p>
        <button type="button" className="btn btn--ghost" onClick={() => void loadMods()}>
          Повторить
        </button>
      </div>
    );
  }

  if (loading || !mods) {
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
        <button type="button" className="btn btn--ghost" onClick={() => void loadMods()}>
          Обновить
        </button>
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

  /** Имя профиля по ключу — для бейджа у мода. */
  const profileName = (key: string): string => {
    const p = (profiles ?? []).find(
      (x) => x.key.toLowerCase() === key.toLowerCase(),
    );
    return p ? p.name : key;
  };

  return (
    <div className="mods-section stagger">
      <p className="muted mods-section__hint stagger-item">
        Дополнительные моды устанавливаются вместе со сборкой. Выключенные не
        загружаются игрой — включение применится при следующем запуске.
      </p>

      {(profiles ?? []).length > 0 && (
        <div className="mod-profiles stagger-item" role="group" aria-label="Профили модов">
          {(profiles ?? []).map((p) => {
            const busy = pendingProfile === p.key;
            return (
              <button
                type="button"
                key={p.key}
                className={
                  "mod-profile" + (p.active ? " mod-profile--on" : "")
                }
                aria-pressed={p.active}
                disabled={busy}
                onClick={() => void toggleProfile(p)}
              >
                <span className="mod-profile__head">
                  <span className="mod-profile__name">{p.name}</span>
                  <span className="mod-profile__count">
                    {p.modCount}{" "}
                    {p.modCount === 1 ? "мод" : p.modCount < 5 ? "мода" : "модов"}
                  </span>
                </span>
                {p.description && (
                  <span className="mod-profile__desc">{p.description}</span>
                )}
                <span className="mod-profile__state" aria-hidden>
                  {busy ? "…" : p.active ? "включён" : "выключен"}
                </span>
              </button>
            );
          })}
        </div>
      )}

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
        const conflicts = activeConflicts(mod);
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
              {mod.profiles.length > 0 && (
                <span className="mods-section__profiles">
                  {mod.profiles.map((k) => (
                    <span className="mods-section__profile-badge" key={k}>
                      {profileName(k)}
                    </span>
                  ))}
                </span>
              )}
              {conflicts.length > 0 && (
                <span className="mods-section__conflict" role="alert">
                  Конфликт с{" "}
                  {conflicts.map((c) => c.name).join(", ")}. Вместе лучше не
                  включать — выключите один из модов.
                </span>
              )}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={mod.enabled}
              aria-label={`${mod.enabled ? "Выключить" : "Включить"} мод: ${mod.name}`}
              disabled={busy}
              className={"switch" + (mod.enabled ? " switch--on" : "")}
              onClick={() => toggle(mod)}
            >
              <span className="switch__knob" />
            </button>
          </div>
        );
      })}
      {q && filtered.length === 0 && (
        <p className="muted">По запросу «{filter.trim()}» ничего не найдено.</p>
      )}
    </div>
  );
}
