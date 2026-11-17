// Поиск и установка модов из Modrinth/CurseForge прямо в сборку.
//
// Три зоны: фильтры слева, список результатов в центре, детали справа.
// Мобильная версия: список → детали → версии через mobileView.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type {
  BuildHeader,
  InstallModRequest,
  ModDetail,
  ModHit,
  ModSource,
  ModVersion,
} from "./types";
import { formatSize, slugifyModId } from "./format";
import { Markdown } from "./ui/Markdown";
import { SafeHtml } from "./ui/SafeHtml";
import { useToast } from "./ui/feedback";
import { useBodyScrollLock } from "./ui/useBodyScrollLock";
import { useDialogFocus } from "./ui/useDialogFocus";
import {
  IconAlert,
  IconArrowLeft,
  IconClose,
  IconDownload,
  IconFilter,
  IconPuzzle,
  IconSearch,
  IconStar,
} from "./ui/icons";
import "./ModSearch.css";

/** Загрузчики, которые понимает Modrinth. */
const SEARCHABLE_LOADERS = new Set(["neoforge", "forge", "fabric", "quilt"]);

/** Популярные категории Modrinth — хардкод, дополнительный запрос не нужен.
 *  Имена строго из /v2/tag/category: `tech`, `transport` и
 *  `world-generation` в Modrinth не существуют — такой фильтр давал 0
 *  результатов при любом запросе. */
const MODRINTH_CATEGORIES = [
  "optimization", "utility", "adventure", "magic", "storage",
  "food", "technology", "mobs", "library", "equipment",
  "transportation", "worldgen", "decoration", "game-mechanics",
];

const SORT_OPTIONS = [
  { value: "downloads", label: "По загрузкам" },
  { value: "newest",    label: "Новые" },
  { value: "updated",   label: "Недавно обновлённые" },
  { value: "follows",   label: "По подпискам" },
  { value: "relevance", label: "По релевантности" },
];

/** Загрузчик сборки → загрузчик Modrinth. */
function loaderFor(build: BuildHeader): string | undefined {
  const kind = build.loaderKind.toLowerCase();
  return SEARCHABLE_LOADERS.has(kind) ? kind : undefined;
}

/** Сторона файла по `environment` версии. */
function sideFor(version: ModVersion): string {
  switch (version.environment) {
    case "client_only": return "client";
    case "server_only": return "server";
    default:            return "both";
  }
}

/** Русская подпись канала версии. */
function typeLabel(t: string): string {
  return t === "release" ? "релиз" : t === "beta" ? "бета" : t === "alpha" ? "альфа" : t;
}

/** Компактное число: 1.2M, 340K. */
function compactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}K`;
  return String(n);
}

/** Имя файла без версии — для `modId`. */
function modIdFromSlug(slug: string): string {
  return slug.trim().toLowerCase() || "mod";
}

export function ModSearch({
  build,
  files,
  onClose,
  onInstalled,
}: {
  build: BuildHeader;
  /** Файлы сборки: по ним помечаем уже установленные моды. */
  files: { modId: string | null; path: string }[];
  onClose: () => void;
  /** Файлы в сборке изменились — нужно перечитать сборку. */
  onInstalled: () => void;
}) {
  const toast = useToast();

  // Поиск
  const [source, setSource] = useState<ModSource>("modrinth");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("downloads");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [hits, setHits] = useState<ModHit[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Детали
  const [picked, setPicked] = useState<ModHit | null>(null);
  const [detail, setDetail] = useState<ModDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Версии
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<ModVersion[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  // Установка
  const [installing, setInstalling] = useState(false);
  const [withDeps, setWithDeps] = useState(true);

  // Мобильная навигация
  const [mobileView, setMobileView] = useState<"list" | "detail" | "versions">("list");
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Lightbox
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const loader = loaderFor(build);
  const canSearch = loader !== undefined;

  // «Уже в сборке»: сравниваем slug/modId файлов.
  const installedIds = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) {
      if (f.modId) set.add(f.modId.toLowerCase());
      const name = f.path.split("/").pop()?.toLowerCase();
      if (name) set.add(name);
    }
    return set;
  }, [files]);

  function isInstalled(hit: ModHit): boolean {
    if (installedIds.has(hit.slug.toLowerCase())) return true;
    return installedIds.has(modIdFromSlug(hit.slug || hit.title));
  }

  // ───── Поиск ─────

  const searchSeq = useRef(0);
  // Зеркало hits для пагинации: runSearch мемоизирован по фильтрам, и в его
  // замыкании `hits` застыл бы на моменте смены фильтров — «Загрузить ещё»
  // запрашивал offset 0 и дублировал первую страницу.
  const hitsRef = useRef<ModHit[]>([]);

  const runSearch = useCallback(async (reset = true) => {
    if (!canSearch) return;
    const offset = reset ? 0 : hitsRef.current.length;
    const seq = ++searchSeq.current;
    if (reset) {
      setSearching(true);
      setSearchError(null);
    } else {
      setLoadingMore(true);
    }
    try {
      const res = await api.searchMods({
        source,
        query: query.trim(),
        loader,
        mcVersion: build.mcVersion,
        offset,
        sort,
        categories: selectedCategories.length > 0 ? selectedCategories : undefined,
      });
      if (seq !== searchSeq.current) return;
      hitsRef.current = reset ? res.hits : [...hitsRef.current, ...res.hits];
      setHits(hitsRef.current);
      setTotalCount(res.totalCount ?? 0);
      setHasMore(hitsRef.current.length < (res.totalCount ?? 0));
    } catch (err) {
      if (seq !== searchSeq.current) return;
      if (reset) {
        hitsRef.current = [];
        setHits([]);
        setSearchError(err instanceof ApiError ? err.message : "Не удалось выполнить поиск");
      }
    } finally {
      if (seq === searchSeq.current) {
        setSearching(false);
        setLoadingMore(false);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [build.mcVersion, canSearch, loader, query, source, sort, selectedCategories]);

  const loadMore = useCallback(() => void runSearch(false), [runSearch]);

  // Смена источника/сортировки/категорий — новый поиск с первой страницы.
  // Этот же эффект делает первичный поиск при открытии: отдельный пустой
  // useEffect давал два-три параллельных одинаковых запроса на маунте.
  useEffect(() => {
    void runSearch(true);
    setPicked(null);
    setDetail(null);
    setVersionsOpen(false);
    setMobileView("list");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, sort, selectedCategories]);

  // ───── Детали мода ─────

  const detailRef = useRef<string | null>(null);

  const pickMod = useCallback(async (hit: ModHit) => {
    const key = `${hit.source}:${hit.id}`;
    detailRef.current = key;
    setPicked(hit);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    setVersionsOpen(false);
    setVersions(null);
    setMobileView("detail");
    try {
      const d = await api.modDetail({ source: hit.source, projectId: hit.id });
      if (detailRef.current !== key) return;
      setDetail(d);
    } catch (err) {
      if (detailRef.current !== key) return;
      setDetailError(err instanceof ApiError ? err.message : "Не удалось загрузить детали");
    } finally {
      if (detailRef.current === key) setDetailLoading(false);
    }
  }, []);

  // ───── Версии ─────

  const loadVersions = useCallback(async () => {
    if (!picked) return;
    setVersionsOpen(true);
    setVersionsLoading(true);
    setVersionsError(null);
    setVersions(null);
    setMobileView("versions");
    try {
      const res = await api.modVersions({
        source: picked.source,
        projectId: picked.id,
        loader,
        mcVersion: build.mcVersion,
      });
      setVersions(res.versions);
    } catch (err) {
      setVersionsError(err instanceof ApiError ? err.message : "Не удалось получить версии");
    } finally {
      setVersionsLoading(false);
    }
  }, [picked, loader, build.mcVersion]);

  const recommended = useMemo(
    () => versions?.find((v) => v.versionType === "release" && v.fileUrl),
    [versions],
  );

  // ───── Установка ─────

  /** Собирает запросы на установку: выбранная версия + зависимости. */
  async function buildInstallPlan(hit: ModHit, version: ModVersion): Promise<{
    items: InstallModRequest[];
    skipped: string[];
  }> {
    if (!version.fileUrl) {
      throw new ApiError(
        0,
        "Хостинг не отдаёт прямую ссылку на этот файл — установите его вручную",
      );
    }
    const items: InstallModRequest[] = [
      {
        url: version.fileUrl,
        path: `mods/${version.fileName || `${hit.slug}-${version.id}.jar`}`,
        side: sideFor(version),
        kind: "mod",
        overwrite: true,
        modId: modIdFromSlug(hit.slug || hit.title),
        displayName: hit.title,
        description: hit.description || undefined,
      },
    ];
    const skipped: string[] = [];
    if (!withDeps) return { items, skipped };

    const required = version.dependencies.filter(
      (d) => d.dependencyType === "required" && d.projectId,
    );
    const seen = new Set<string>([`${hit.source}:${hit.id}`]);
    for (const dep of required) {
      const key = `${hit.source}:${dep.projectId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const res = await api.resolveMod({
          source: hit.source,
          projectId: dep.projectId!,
          loader,
          mcVersion: build.mcVersion,
        });
        if (!res.version?.fileUrl) {
          skipped.push(dep.title ?? dep.projectId!);
          continue;
        }
        items.push({
          url: res.version.fileUrl,
          path: `mods/${res.version.fileName || `${dep.projectId}-${res.version.id}.jar`}`,
          side: sideFor(res.version),
          kind: "mod",
          overwrite: true,
          modId: slugifyModId(res.version.fileName || dep.projectId || "mod"),
          displayName: dep.title,
        });
      } catch {
        skipped.push(dep.title ?? dep.projectId!);
      }
    }
    return { items, skipped };
  }

  async function install(hit: ModHit, version: ModVersion) {
    setInstalling(true);
    try {
      const plan = await buildInstallPlan(hit, version);
      const results = await api.installMods(build.id, plan.items);
      const ok = results.filter((r) => !r.error);
      const failed = results.filter((r) => r.error);
      if (ok.length > 0) {
        const extra = plan.skipped.length
          ? `, зависимости без файла: ${plan.skipped.join(", ")}`
          : "";
        toast.success(
          ok.length === 1
            ? `«${hit.title}» добавлен в сборку${extra}`
            : `Добавлено файлов: ${ok.length} («${hit.title}» и зависимости)${extra}`,
        );
        onInstalled();
      }
      if (failed.length > 0) {
        const detail = failed.map((f) => `${f.path}: ${f.error}`).join("; ");
        toast.error(`Не удалось установить ${failed.length}: ${detail}`);
      }
      if (ok.length > 0) onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Не удалось установить мод");
    } finally {
      setInstalling(false);
    }
  }

  // ───── Раскладка ─────

  const dialogRef = useRef<HTMLDivElement>(null);
  useBodyScrollLock();
  useDialogFocus(dialogRef, () => {
    if (!installing) onClose();
  });

  const toggleCategory = (cat: string) =>
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );

  return (
    <>
      <div
        className="modsearch-overlay"
        onClick={() => !installing && onClose()}
      >
        <div
          ref={dialogRef}
          className="modsearch-shell"
          role="dialog"
          aria-modal="true"
          aria-label="Поиск модов"
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Шапка */}
          <div className="modsearch-header">
            <span className="modsearch-header-icon">
              <IconPuzzle size={18} />
            </span>
            <div className="modsearch-header-title">
              <h2>{picked ? picked.title : "Поиск модов"}</h2>
              <p className="muted">
                {picked
                  ? `${picked.author || "неизвестный автор"} · ${compactNum(picked.downloads)} загрузок`
                  : `${build.loaderKind} · MC ${build.mcVersion}`}
              </p>
            </div>
            <div className="modsearch-header-actions">
              <button
                className="icon-only ghost"
                aria-label="Закрыть"
                onClick={onClose}
                disabled={installing}
              >
                <IconClose size={16} />
              </button>
            </div>
          </div>

          {/* Тело */}
          <div className="modsearch-body">

            {/* ── Левая колонка: фильтры ── */}
            <aside className={`modsearch-sidebar${filtersOpen ? " open" : ""}`}>
              <div className="modsearch-source-tabs" role="tablist" aria-label="Источник модов">
                <button
                  role="tab"
                  aria-selected={source === "modrinth"}
                  className={source === "modrinth" ? "active" : ""}
                  onClick={() => setSource("modrinth")}
                >
                  Modrinth
                </button>
                <button
                  role="tab"
                  aria-selected={source === "curseforge"}
                  className={source === "curseforge" ? "active" : ""}
                  onClick={() => setSource("curseforge")}
                >
                  CurseForge
                </button>
              </div>

              {source === "modrinth" && (
                <div className="modsearch-filter-group">
                  <p className="modsearch-filter-label">Категории</p>
                  <div className="modsearch-filter-tags">
                    {MODRINTH_CATEGORIES.map((cat) => (
                      <button
                        key={cat}
                        className={`modsearch-filter-tag${selectedCategories.includes(cat) ? " active" : ""}`}
                        onClick={() => toggleCategory(cat)}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </aside>

            {/* ── Центральная колонка: результаты ── */}
            <div className="modsearch-results-pane">
              <div className="modsearch-search-bar">
                <form
                  className="search"
                  style={{ flex: 1 }}
                  onSubmit={(e) => { e.preventDefault(); void runSearch(true); }}
                >
                  <IconSearch size={14} />
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={`Название мода`}
                  />
                </form>
                <select
                  className="modsearch-sort-select"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <button
                  className="modsearch-filters-btn"
                  onClick={() => setFiltersOpen((v) => !v)}
                  aria-label="Фильтры"
                >
                  <IconFilter size={14} />
                  Фильтры
                </button>
              </div>

              {!canSearch ? (
                <div className="modsearch-empty">
                  Поиск модов недоступен для загрузчика «{build.loaderKind}»: Vanilla модов не имеет.
                </div>
              ) : (
                <>
                  {searchError && <div className="error" style={{ margin: "12px 16px 0" }}>{searchError}</div>}
                  {source === "curseforge" && searchError && (
                    <p className="muted" style={{ margin: "4px 16px", fontSize: "12px" }}>
                      CurseForge требует API-ключ: «Настройки» → «CurseForge API Key».
                    </p>
                  )}

                  <div className="modsearch-results-list" aria-busy={searching}>
                    {searching && hits.length === 0 && (
                      <p className="muted" style={{ padding: "24px", textAlign: "center", fontSize: "13px" }}>
                        Поиск…
                      </p>
                    )}
                    {!searching && hits.length === 0 && !searchError && (
                      <p className="muted" style={{ padding: "24px", textAlign: "center", fontSize: "13px" }}>
                        Ничего не найдено под {loader ?? "этот загрузчик"} и MC {build.mcVersion}.
                      </p>
                    )}
                    {hits.map((h) => (
                      <button
                        key={`${h.source}:${h.id}`}
                        className={`modsearch-hit${picked?.id === h.id && picked.source === h.source ? " active" : ""}${isInstalled(h) ? " installed" : ""}`}
                        onClick={() => void pickMod(h)}
                      >
                        <HitIcon url={h.iconUrl} />
                        <span className="modsearch-hit-body">
                          <span className="modsearch-hit-title">
                            {h.title}
                            {isInstalled(h) && <span className="modsearch-tag-installed">в сборке</span>}
                            <span className="modsearch-hit-author">{h.author}</span>
                          </span>
                          <span className="modsearch-hit-desc">{h.description}</span>
                          <span className="modsearch-hit-meta">
                            <IconDownload size={12} />
                            {compactNum(h.downloads)}
                            {h.categories.slice(0, 3).map((c) => (
                              <span key={c} className="modsearch-chip">{c}</span>
                            ))}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>

                  {hasMore && (
                    <div className="modsearch-load-more">
                      <button onClick={loadMore} disabled={loadingMore || searching}>
                        {loadingMore ? "Загрузка…" : "Загрузить ещё"}
                      </button>
                      {totalCount > 0 && (
                        <span className="modsearch-results-count">
                          {hits.length} из {totalCount}
                        </span>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
            {/* ── Конец центральной колонки ── */}

            {/* ── Правая колонка: детали ── */}
            <aside
              className={`modsearch-detail-pane${mobileView === "detail" || mobileView === "versions" ? " mobile-active" : ""}`}
            >
              {/* Мобильная кнопка «Назад» */}
              <button
                className="modsearch-mobile-back"
                onClick={() => { setMobileView("list"); setPicked(null); setVersionsOpen(false); }}
              >
                <IconArrowLeft size={14} />
                К результатам
              </button>

              {!picked ? (
                <div className="modsearch-detail-empty">
                  <IconPuzzle size={36} />
                  <p>Выберите мод из списка, чтобы увидеть подробную информацию</p>
                </div>
              ) : detailLoading ? (
                <DetailSkeleton />
              ) : detailError ? (
                <div className="modsearch-detail-empty">
                  <IconAlert size={28} />
                  <p>Детали недоступны: {detailError}</p>
                  <button className="secondary" onClick={() => void pickMod(picked)}>
                    Повторить
                  </button>
                </div>
              ) : detail ? (
                <>
                  <div className="modsearch-detail-header">
                    <div className="modsearch-detail-top">
                      <HitIcon url={detail.iconUrl} large />
                      <div className="modsearch-detail-title-block">
                        <h3>{detail.title}</h3>
                        <span className="modsearch-detail-author">{detail.author}</span>
                      </div>
                    </div>
                    <div className="modsearch-detail-stats">
                      <span className="modsearch-stat">
                        <IconDownload size={12} /> {compactNum(detail.downloads)} загрузок
                      </span>
                      {detail.followers > 0 && (
                        <span className="modsearch-stat">
                          <IconStar size={12} /> {compactNum(detail.followers)}
                        </span>
                      )}
                    </div>
                    {detail.categories.length > 0 && (
                      <div className="modsearch-detail-cats">
                        {detail.categories.map((c) => (
                          <span key={c} className="modsearch-chip">{c}</span>
                        ))}
                      </div>
                    )}
                    {(detail.issuesUrl || detail.sourceUrl || detail.wikiUrl || detail.discordUrl) && (
                      <div className="modsearch-detail-links">
                        {detail.issuesUrl && (
                          <a href={detail.issuesUrl} target="_blank" rel="noreferrer" className="modsearch-detail-link">
                            Issues
                          </a>
                        )}
                        {detail.sourceUrl && (
                          <a href={detail.sourceUrl} target="_blank" rel="noreferrer" className="modsearch-detail-link">
                            Source
                          </a>
                        )}
                        {detail.wikiUrl && (
                          <a href={detail.wikiUrl} target="_blank" rel="noreferrer" className="modsearch-detail-link">
                            Wiki
                          </a>
                        )}
                        {detail.discordUrl && (
                          <a href={detail.discordUrl} target="_blank" rel="noreferrer" className="modsearch-detail-link">
                            Discord
                          </a>
                        )}
                      </div>
                    )}
                  </div>

                  {detail.gallery.length > 0 && (
                    <div className="modsearch-gallery">
                      {detail.gallery.map((img) => (
                        <img
                          key={img.url}
                          src={img.url}
                          alt={img.title ?? ""}
                          onClick={() => setLightboxUrl(img.url)}
                        />
                      ))}
                    </div>
                  )}

                  <div className="modsearch-detail-body">
                    {detail.bodyFormat === "markdown" ? (
                      <Markdown text={detail.body} />
                    ) : (
                      <SafeHtml html={detail.body} className="modsearch-html-body" />
                    )}
                  </div>

                  <div className="modsearch-versions-btn-row">
                    <label className="modsearch-deps-toggle">
                      <input
                        type="checkbox"
                        checked={withDeps}
                        onChange={(e) => setWithDeps(e.target.checked)}
                      />
                      <span>Ставить обязательные зависимости автоматически</span>
                    </label>
                    <button className="primary" onClick={() => void loadVersions()}>
                      Выбрать версию…
                    </button>
                  </div>
                </>
              ) : null}

              {/* Drawer версий поверх детали */}
              {versionsOpen && picked && (
                <VersionsDrawer
                  hit={picked}
                  versions={versions}
                  loading={versionsLoading}
                  error={versionsError}
                  recommended={recommended}
                  installing={installing}
                  onInstall={(v) => void install(picked, v)}
                  onClose={() => { setVersionsOpen(false); setMobileView("detail"); }}
                />
              )}
            </aside>
          </div>
        </div>
      </div>

      {lightboxUrl && (
        <div className="modsearch-lightbox" onClick={() => setLightboxUrl(null)}>
          <img src={lightboxUrl} alt="" onClick={(e) => e.stopPropagation()} />
          <button
            className="modsearch-lightbox-close icon-only ghost"
            onClick={() => setLightboxUrl(null)}
            aria-label="Закрыть"
          >
            <IconClose size={20} />
          </button>
        </div>
      )}
    </>
  );
}

// ───── Иконка мода с fallback на placeholder ─────
//
// При ошибке загрузки (CORS, 404 и т.п.) показываем иконку пазла.
// loading="eager" — иконки в видимой области, lazy мешает первому рендеру.

function HitIcon({ url, large }: { url: string | null; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  const size = large ? 56 : 44;
  const cls = large ? "modsearch-detail-img" : "modsearch-hit-img";
  const placeholderCls = large ? "modsearch-detail-icon" : "modsearch-hit-icon";
  const iconSize = large ? 24 : 20;

  if (!url || failed) {
    return (
      <span className={placeholderCls} style={{ width: size, height: size }}>
        <IconPuzzle size={iconSize} />
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      className={cls}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}

// ───── Скелетон детали ─────

function DetailSkeleton() {
  return (
    <div className="modsearch-skeleton">
      <div style={{ display: "flex", gap: 14 }}>
        <div className="modsearch-skeleton-line" style={{ width: 56, height: 56, flexShrink: 0 }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="modsearch-skeleton-line" style={{ height: 18, width: "60%" }} />
          <div className="modsearch-skeleton-line" style={{ height: 13, width: "40%" }} />
        </div>
      </div>
      <div className="modsearch-skeleton-line" style={{ height: 13, width: "80%" }} />
      <div className="modsearch-skeleton-line" style={{ height: 13, width: "95%" }} />
      <div className="modsearch-skeleton-line" style={{ height: 13, width: "70%" }} />
      <div className="modsearch-skeleton-line" style={{ height: 13, width: "85%" }} />
      <div className="modsearch-skeleton-line" style={{ height: 13, width: "60%" }} />
    </div>
  );
}

// ───── Drawer версий ─────

function VersionsDrawer({
  hit,
  versions,
  loading,
  error,
  recommended,
  installing,
  onInstall,
  onClose,
}: {
  hit: ModHit;
  versions: ModVersion[] | null;
  loading: boolean;
  error: string | null;
  recommended?: ModVersion;
  installing: boolean;
  onInstall: (v: ModVersion) => void;
  onClose: () => void;
}) {
  return (
    <div className="modsearch-versions-drawer">
      <div className="modsearch-versions-drawer-head">
        <button className="icon-only ghost" onClick={onClose} aria-label="Назад">
          <IconArrowLeft size={16} />
        </button>
        <h3>Версии — {hit.title}</h3>
      </div>

      {loading && (
        <p className="muted" style={{ padding: "24px", textAlign: "center", fontSize: "13px" }}>
          Загружаю версии…
        </p>
      )}
      {error && <div className="error" style={{ margin: 16 }}>{error}</div>}
      {!loading && !error && versions && versions.length === 0 && (
        <p className="muted" style={{ padding: "24px", textAlign: "center", fontSize: "13px" }}>
          Подходящих версий нет.
        </p>
      )}

      {versions && versions.length > 0 && (
        <div className="modsearch-versions-list">
          {versions.map((v) => {
            const primary = recommended?.id === v.id;
            const blocked = !v.fileUrl;
            return (
              <div
                key={v.id}
                className={`modsearch-version-item${primary ? " recommended" : ""}${blocked ? " blocked" : ""}`}
              >
                <div className="modsearch-version-info">
                  <div className="modsearch-version-title">
                    <span>{v.name || v.versionNumber}</span>
                    <span className={`modsearch-type modsearch-type--${v.versionType}`}>
                      {typeLabel(v.versionType)}
                    </span>
                    {primary && (
                      <span className="modsearch-type recommended-tag">рекомендуется</span>
                    )}
                  </div>
                  <div className="modsearch-version-meta">
                    <span>{v.fileName}</span>
                    {v.fileSize > 0 && <span>{formatSize(v.fileSize)}</span>}
                    {v.datePublished && (
                      <span>{new Date(v.datePublished).toLocaleDateString("ru-RU")}</span>
                    )}
                    {v.dependencies.filter((d) => d.dependencyType === "required").length > 0 && (
                      <span>
                        зависимостей:{" "}
                        {v.dependencies.filter((d) => d.dependencyType === "required").length}
                      </span>
                    )}
                  </div>
                  {blocked && (
                    <div className="modsearch-version-blocked">
                      <IconAlert size={13} /> Хостинг запретил прямую загрузку файла
                    </div>
                  )}
                </div>
                <button
                  className={primary ? "primary" : "secondary"}
                  disabled={installing || blocked}
                  onClick={() => onInstall(v)}
                >
                  {installing && primary ? "Устанавливаю…" : "В сборку"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}







