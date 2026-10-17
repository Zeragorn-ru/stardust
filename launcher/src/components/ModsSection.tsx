import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModProfileInfo, OptionalMod } from "../types";
import { listModProfiles, listOptionalMods, selectModProfile, setModEnabled } from "../api";
import { formatBytes } from "../format";

function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

/** Русская плюрализация: 1 мод / 2-4 мода / 5+ модов, включая 21 мод. */
function pluralRu(n: number, one: string, few: string, many: string): string {
  if (n % 100 >= 11 && n % 100 <= 14) return many;
  if (n % 10 === 1) return one;
  if (n % 10 >= 2 && n % 10 <= 4) return few;
  return many;
}

export default function ModsSection() {
  const [mods, setMods] = useState<OptionalMod[] | null>(null);
  const [profiles, setProfiles] = useState<ModProfileInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  // modId-ы, по которым идёт переключение (блокируем повторные клики).
  const [pending, setPending] = useState<Set<string>>(new Set());
  // Ключ профиля, который сейчас выбирается.
  const [pendingProfile, setPendingProfile] = useState<string | null>(null);
  // Сбой переключения профиля: строка ошибки над рейлом (откат уже отыгран).
  const [profileError, setProfileError] = useState<string | null>(null);
  // Постфактум-заметка о потерях ручных включений (не ошибка — нейтральный тон).
  const [switchingNote, setSwitchingNote] = useState<string | null>(null);
  // Свернута ли группа «В других пресетах» (нет смысла в шуме по умолчанию).
  const [othersCollapsed, setOthersCollapsed] = useState(true);
  // Одноразовый счётчик «привет» после переключения пресета.
  const [bump, setBump] = useState(false);
  const bumpTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (bumpTimer.current !== null) {
        window.clearTimeout(bumpTimer.current);
      }
    },
    [],
  );

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

  const selectedProfile = useMemo(
    () => (profiles ?? []).find((p) => p.selected) ?? null,
    [profiles],
  );

  // Разворачиваемый блок состава выбранного пресета. Высота панели
  // анимируется точным значением (замер scrollHeight), а не «с запасом»:
  // анимация max-height до выдуманного потолка даёт мёртвый хвост и
  // дёрганый ритм. Замер обновляется при смене пресета (состав другой).
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const disclosureRef = useRef<HTMLDivElement>(null);
  const [disclosureHeight, setDisclosureHeight] = useState<number | null>(null);
  const selectedProfileKey = selectedProfile?.key ?? null;

  useEffect(() => {
    const el = disclosureRef.current;
    if (!el) return;
    const measure = () => setDisclosureHeight(el.scrollHeight);
    measure();
    // Содержимое приходит из тех же данных, но шрифты/чипы могут
    // доехать позже — переснимаем после отрисовки кадра.
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [selectedProfileKey, disclosureOpen]);

  // Клавиатура рейла: стрелки двигают ФОКУС по radio-кнопкам с
  // заворотом (как нативный radiogroup), выбор — только Enter/Space
  // через нативный клик button: перебор стрелками не должен писать
  // на диск при каждом нажатии.
  const onRailKeyDown = (e: React.KeyboardEvent) => {
    if (
      e.key !== "ArrowLeft" &&
      e.key !== "ArrowRight" &&
      e.key !== "ArrowUp" &&
      e.key !== "ArrowDown"
    ) {
      return;
    }
    const rail = e.currentTarget;
    const buttons = Array.from(
      rail.querySelectorAll<HTMLButtonElement>("button[role='radio']:not(:disabled)"),
    );
    if (buttons.length === 0) return;
    e.preventDefault();
    // Фокус вне кнопок (−1) ведёт себя как «до первого»: вперёд — на
    // первый, назад — на последний (нативная семантика radiogroup).
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const dir = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    const next = (Math.max(currentIndex, 0) + dir + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  /** Активные конфликты для мода: включённые моды из conflictsWith. */
  function activeConflicts(mod: OptionalMod): OptionalMod[] {
    if (!mod.enabled) return [];
    const ids = mod.conflictsWith ?? [];
    return ids
      .map((id) => byId.get(normalizeId(id)))
      .filter((other): other is OptionalMod => other != null && other.enabled);
  }

  async function toggle(mod: OptionalMod) {
    // Не спорим с идущим переключением профиля (см. selectProfile);
    // неопциональные моды руками не переключаются вовсе.
    if (pendingProfile !== null || mod.locked || !mod.optional) return;
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

  async function selectProfile(profile: ModProfileInfo) {
    // Мьютекс: пока идёт выбор профиля, блокируем и другие профили, и
    // индивидуальные моды — их запись в choices-файл перетёрла бы параллельную
    // запись профиля (lost update), а откат по снимку затирал бы чужие
    // оптимистичные изменения.
    if (pendingProfile !== null || pending.size > 0 || profile.selected) return;
    // Снимок состояния модов до переключения — для точного отката.
    const modsSnapshot = mods ?? [];
    const profilesSnapshot = profiles ?? [];
    // Потери ручных включений: моды, которые игрок сам включил руками
    // (optional, не от гейта), но которые выключатся при смене профиля.
    // Считаем ДО оптимистичного обновления, по текущему состоянию.
    const switchingLoss = modsSnapshot.filter(
      (m) =>
        m.optional &&
        m.enabled &&
        !m.locked &&
        m.profiles.length > 0 &&
        !m.profiles.some(
          (k) => k.toLowerCase() === profile.key.toLowerCase(),
        ),
    );
    setPendingProfile(profile.key);
    setProfileError(null);
    setSwitchingNote(null);
    // Оптимистично: помечаем выбранный профиль и пересчитываем моды по гейту.
    setProfiles((prev) =>
      prev
        ? prev.map((p) => ({ ...p, selected: p.key === profile.key }))
        : prev,
    );
    setMods((prev) =>
      prev
        ? prev.map((m) => {
            const inProfile =
              m.profiles.length === 0 ||
              m.profiles.some(
                (k) => k.toLowerCase() === profile.key.toLowerCase(),
              );
            if (inProfile) {
              // Моды нового профиля: снимаем лок; неопциональные включены
              // по гейту всегда (см. file_enabled), опциональные получат
              // точное состояние из перечитывания ниже.
              return m.optional
                ? m.locked
                  ? { ...m, locked: false }
                  : m
                : { ...m, locked: false, enabled: true };
            }
            return {
              ...m,
              locked: true,
              enabled: false,
            };
          })
        : prev,
    );
    try {
      await selectModProfile(profile.key);
      // Перечитываем согласованное состояние, ПОКА блокировка ещё держится:
      // тумблер или второй выбор в окне refetch перетёрлись бы устаревшим
      // ответом (UI и диск расходятся до перемонтирования экрана).
      const [list, profileList] = await Promise.allSettled([
        listOptionalMods(),
        listModProfiles(),
      ]);
      if (list.status === "fulfilled") setMods(list.value);
      if (profileList.status === "fulfilled") setProfiles(profileList.value);
      if (list.status === "rejected" || profileList.status === "rejected") {
        // Переключение на диске уже применено — не откатываем, но и не
        // глотаем: штатная перезагрузка при повторном сбое покажет экран
        // ошибки с «Повторить».
        void loadMods();
      }
    } catch {
      // Откат к снимку: профили и моды возвращаются к прежнему состоянию.
      setMods(modsSnapshot);
      setProfiles(profilesSnapshot);
      setProfileError("Не удалось переключить пресет — попробуйте ещё раз");
      return;
    } finally {
      setPendingProfile(null);
    }
    // Одноразовая «пульсация» счётчика после применения.
    setBump(true);
    if (bumpTimer.current !== null) {
      window.clearTimeout(bumpTimer.current);
    }
    bumpTimer.current = window.setTimeout(() => setBump(false), 260);
    // Заметка о ручных потерях: то, что игрок включал руками и что
    // выключится в новом пресете. Показываем после переключения,
    // чтобы не блокировать выбор и не пугать до клика.
    if (switchingLoss.length > 0) {
      const lossNames = switchingLoss
        .slice(0, 3)
        .map((m) => m.name)
        .join(", ");
      setSwitchingNote(
        switchingLoss.length > 3
          ? `${switchingLoss.length} мода(ов), включённых руками, выключились — включая ${lossNames}…`
          : `${switchingLoss.length} ${pluralRu(switchingLoss.length, "мод", "мода", "модов")}, включённые руками, выключились: ${lossNames}`,
      );
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

  /** Объект профиля по ключу — для ссылки-переключения из locked-note. */
  const profileByKey = (key: string): ModProfileInfo | null => {
    const p = (profiles ?? []).find(
      (x) => x.key.toLowerCase() === key.toLowerCase(),
    );
    return p ?? null;
  };

  // Группы: «Из пресета» (профильные), «Общие» (без тегов),
  // «В других пресетах» (locked) — свёрнутая по умолчанию.
  const fromPreset = filtered.filter(
    (m) => m.profiles.length > 0 && !m.locked,
  );
  const common = filtered.filter((m) => m.profiles.length === 0);
  const others = filtered.filter((m) => m.locked);
  const othersExpanded = !othersCollapsed || q.length > 0;
  const enabledCount = mods.filter((m) => m.enabled).length;
  // Знаменатель — только доступные в текущем пресете моды: залоченные
  // в других пресетах включить невозможно, и «X из Y» с ними обещал бы
  // недостижимый максимум.
  const accessibleCount = mods.filter((m) => !m.locked).length;
  const hasProfiles = (profiles ?? []).length > 0;
  const singleProfile = hasProfiles && (profiles ?? []).length === 1;

  /** Ряд мода (существующий .toggle-row) с новыми бейджами. */
  function renderRow(mod: OptionalMod) {
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
          {mod.locked && (
            <span className="muted mods-section__locked-note">
              Доступен в пресете{" "}
              {mod.profiles.map((k, i) => {
                const target = profileByKey(k);
                const sep = i > 0 ? " / " : "";
                if (!target) {
                  // Профиля с этим ключом нет в сборке (мусорный тег) —
                  // просто имя, без «нажмите».
                  return (
                    <span key={k}>
                      {sep}«{profileName(k)}»
                    </span>
                  );
                }
                return (
                  <span key={k}>
                    {sep}
                    <button
                      type="button"
                      className="new-preset-link"
                      disabled={pendingProfile !== null}
                      onClick={() => void selectProfile(target)}
                    >
                      «{profileName(k)}»
                    </button>
                  </span>
                );
              })}
              {" — выберите его, чтобы включить."}
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
        {mod.optional ? (
          <button
            type="button"
            role="switch"
            aria-checked={mod.enabled}
            aria-disabled={mod.locked}
            aria-label={`${mod.enabled ? "Выключить" : "Включить"} мод: ${mod.name}`}
            disabled={busy || mod.locked}
            title={
              mod.locked
                ? "Мод недоступен в выбранном пресете"
                : undefined
            }
            className={
              "switch" +
              (mod.enabled ? " switch--on" : "") +
              (mod.locked ? " switch--locked" : "")
            }
            onClick={() => toggle(mod)}
          >
            <span className="switch__knob" />
          </button>
        ) : (
          <span
            className="mods-section__profile-state"
            title="Обязательный мод пресета — переключается выбором пресета"
          >
            {mod.enabled ? "от профиля" : "выключен"}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="mods-section stagger">
      <p className="muted mods-section__hint stagger-item">
        Дополнительные моды устанавливаются вместе со сборкой. Выключенные не
        загружаются игрой — включение применится при следующем запуске.
      </p>

      {/* Пресет: sticky-блок, сегмент-рейл + разворачиваемый состав.
          ВАЖНО: классы .customize-tab* заимствованы у табов кастомизации —
          там role=tab, здесь role=radio; семантика задаётся атрибутами
          на кнопках, не «чините» на tablist. */}
      {hasProfiles && (
        <section className="new-preset-step stagger-item">
          {!singleProfile && (
            <header className="new-preset-step__head">
              <h3 className="new-preset-step__title">Пресет</h3>
              <p className="new-preset-step__sub">
                Выберите один — моды настроятся сами, отдельные можно
                поменять ниже
              </p>
            </header>
          )}
          {singleProfile ? (
            <div className="new-preset new-preset--single" role="status">
              <span className="new-preset__profile">
                Пресет: {selectedProfile?.name}
              </span>
              <span className="new-preset__meta">
                {(selectedProfile?.modCount ?? 0) > 0
                  ? `${selectedProfile?.modCount} ${pluralRu(selectedProfile?.modCount ?? 0, "мод", "мода", "модов")}`
                  : "Только базовые моды"}
              </span>
            </div>
          ) : (
            <div
              className={
                "customize-tabs preset-rail" + (pendingProfile ? " preset-rail--busy" : "")
              }
              style={{ "--tabs-n": (profiles ?? []).length } as React.CSSProperties}
              role="radiogroup"
              aria-label="Пресет модов"
              onKeyDown={onRailKeyDown}
            >
              {(profiles ?? []).map((p) => (
                <button
                  type="button"
                  key={p.key}
                  role="radio"
                  aria-checked={p.selected}
                  tabIndex={p.selected ? 0 : -1}
                  disabled={pendingProfile !== null}
                  className={
                    "customize-tab customize-tab--stack" + (p.selected ? " is-active" : "")
                  }
                  title={
                    p.key === (profiles ?? [])[0]?.key
                      ? `${p.name} — по умолчанию`
                      : p.name
                  }
                  onClick={() => void selectProfile(p)}
                >
                  <span className="customize-tab__label">{p.name}</span>
                  <span className="customize-tab__sub">
                    {pendingProfile === p.key
                      ? "Переключение…"
                      : p.modCount > 0
                        ? `${p.modCount} ${pluralRu(p.modCount, "мод", "мода", "модов")}`
                        : "Только базовые моды"}
                  </span>
                </button>
              ))}
              <span
                className="customize-tabs__ink"
                aria-hidden
                style={
                  { "--tabs-i": (profiles ?? []).findIndex((p) => p.selected) } as React.CSSProperties
                }
              />
            </div>
          )}
          {/* Разворачиваемый состав выбранного пресета: имя, «по
              умолчанию», описание, эксклюзивные моды чипами. Меняется
              сам при смене пресета. */}
          {selectedProfile && (
            <div className={"preset-disclosure" + (disclosureOpen ? " preset-disclosure--open" : "")}>
              <button
                type="button"
                className="new-mods-step__group-toggle preset-disclosure__toggle"
                aria-expanded={disclosureOpen}
                aria-controls="preset-disclosure-panel"
                disabled={pendingProfile !== null}
                onClick={() => setDisclosureOpen((v) => !v)}
              >
                <span aria-hidden>{disclosureOpen ? "▾" : "▸"}</span> Описание
              </button>
              <div
                ref={disclosureRef}
                className="preset-disclosure__panel"
                id="preset-disclosure-panel"
                role="region"
                aria-label={`Описание пресета ${selectedProfile.name}`}
                style={
                  disclosureOpen && disclosureHeight != null
                    ? { maxHeight: `${disclosureHeight}px` }
                    : undefined
                }
              >
                {selectedProfile.description && (
                  <p className="preset-disclosure__desc">{selectedProfile.description}</p>
                )}
              </div>
            </div>
          )}
          {profileError && (
            <p className="form-msg form-msg--error" role="alert">{profileError}</p>
          )}
          {!profileError && switchingNote && (
            <p className="form-msg new-preset-step__note-live" role="status">
              {switchingNote}
            </p>
          )}
        </section>
      )}

      {/* Моды как следствие выбора пресета. */}
      <section className="new-mods-step">
        <header className="new-mods-step__head" role="status" aria-live="polite">
          <h3 className="new-mods-step__title">Моды</h3>
          {selectedProfile && (
            <span
              key={selectedProfile.key}
              className="new-mods-step__context"
            >
              пресет «{selectedProfile.name}»
            </span>
          )}
          <span
            className={
              "new-mods-step__count" + (bump ? " new-mods-step__count--bump" : "")
            }
          >
            включено {enabledCount} из {accessibleCount}
          </span>
        </header>

        <input
          type="text"
          className="input mods-section__filter"
          placeholder="Поиск модов…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        {fromPreset.length > 0 && (
          <div className="new-mods-step__group">
            <p className="new-mods-step__group-title">Из пресета</p>
            {fromPreset.map((m) => renderRow(m))}
          </div>
        )}
        {common.length > 0 && (
          <div className="new-mods-step__group">
            <p className="new-mods-step__group-title">Общие</p>
            {common.map((m) => renderRow(m))}
          </div>
        )}
        {others.length > 0 && (
          <div
            className={
              "new-mods-step__group" +
              (!othersExpanded ? " new-mods-step__group--collapsed" : "")
            }
          >
            <button
              type="button"
              className="new-mods-step__group-toggle"
              aria-expanded={othersExpanded}
              disabled={q.length > 0}
              onClick={() => setOthersCollapsed((v) => !v)}
            >
              {othersExpanded ? "▾" : "▸"} В других пресетах · {others.length}
            </button>
            {others.map((m) => renderRow(m))}
          </div>
        )}
        {q && filtered.length === 0 && (
          <p className="muted">По запросу «{filter.trim()}» ничего не найдено.</p>
        )}
      </section>
    </div>
  );
}
