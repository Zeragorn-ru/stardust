// Поиск и установка модов из Modrinth/CurseForge прямо в сборку.
//
// Мод выбирается под MC-версию и загрузчик сборки; версии (файлы) и их
// зависимости запрашиваются у хостинга через admin-server (браузер на
// внешние API не ходит). Установка идёт server-side: сервер сам качает
// JAR по URL, считает SHA-1 и кладёт в контент-адресное хранилище —
// байты не проходят через браузер.
//
// Три шага в одном диалоге:
//   1. поиск (список проектов);
//   2. выбор версии под MC/загрузчик (release по умолчанию);
//   3. установка выбранного мода вместе с обязательными зависимостями.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type {
  BuildHeader,
  InstallModRequest,
  ModHit,
  ModSource,
  ModVersion,
} from "./types";
import { formatSize, slugifyModId } from "./format";
import { useToast } from "./ui/feedback";
import { useBodyScrollLock } from "./ui/useBodyScrollLock";
import { useDialogFocus } from "./ui/useDialogFocus";
import {
  IconAlert,
  IconArrowLeft,
  IconClose,
  IconDownload,
  IconPuzzle,
  IconSearch,
} from "./ui/icons";
import "./ModSearch.css";

/** Загрузчики, которые понимает Modrinth (vanilla модов не имеет). */
const SEARCHABLE_LOADERS = new Set(["neoforge", "forge", "fabric", "quilt"]);

/**
 * Загрузчик сборки → загрузчик Modrinth. NeoForge и Forge на Modrinth —
 * разные категории, но у части модов указана только одна из них; fallback
 * обрабатывается на бэкенде пустым фильтром, поэтому здесь только точное
 * соответствие.
 */
function loaderFor(build: BuildHeader): string | undefined {
  const kind = build.loaderKind.toLowerCase();
  return SEARCHABLE_LOADERS.has(kind) ? kind : undefined;
}

/** Сторона файла по `environment` версии Modrinth. */
function sideFor(version: ModVersion): string {
  switch (version.environment) {
    case "client_only":
      return "client";
    case "server_only":
      return "server";
    default:
      return "both";
  }
}

/** Русская подпись канала версии. */
function typeLabel(t: string): string {
  return t === "release" ? "релиз" : t === "beta" ? "бета" : t === "alpha" ? "альфа" : t;
}

/** Компактное число загрузок: 1.2M, 340K. */
function formatDownloads(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
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
  const [source, setSource] = useState<ModSource>("modrinth");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ModHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Выбранный проект и его версии.
  const [picked, setPicked] = useState<ModHit | null>(null);
  const [versions, setVersions] = useState<ModVersion[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);

  // Установка.
  const [installing, setInstalling] = useState(false);
  const [withDeps, setWithDeps] = useState(true);

  // Клик по результату, пока версии в пути, не должен «передумываться»
  // медленным ответом предыдущего проекта.
  const selectedRef = useRef<string | null>(null);

  const loader = loaderFor(build);
  const canSearch = loader !== undefined;

  const loadVersions = useCallback(
    async (hit: ModHit) => {
      const wanted = `${hit.source}:${hit.id}`;
      selectedRef.current = wanted;
      setPicked(hit);
      setVersions(null);
      setVersionsError(null);
      setVersionsLoading(true);
      try {
        const res = await api.modVersions({
          source: hit.source,
          projectId: hit.id,
          loader,
          mcVersion: build.mcVersion,
        });
        if (selectedRef.current !== wanted) return;
        setVersions(res.versions);
      } catch (err) {
        if (selectedRef.current !== wanted) return;
        setVersionsError(err instanceof ApiError ? err.message : "Не удалось получить версии");
      } finally {
        // Устаревший ответ не должен гасить спиннер нового проекта: иначе
        // список «пуст», пока грузится выбранный.
        if (selectedRef.current === wanted) setVersionsLoading(false);
      }
    },
    [build.mcVersion, loader],
  );

  // Номер последнего поиска: устаревший ответ (пока летел, пользователь
  // сменил источник или нажал «Найти» ещё раз) не перезаписывает список.
  const searchSeq = useRef(0);

  const runSearch = useCallback(async () => {
    if (!canSearch) return;
    const seq = ++searchSeq.current;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await api.searchMods({
        source,
        query: query.trim(),
        loader,
        mcVersion: build.mcVersion,
      });
      if (seq !== searchSeq.current) return;
      setHits(res.hits);
    } catch (err) {
      if (seq !== searchSeq.current) return;
      setHits(null);
      setSearchError(err instanceof ApiError ? err.message : "Не удалось выполнить поиск");
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, [build.mcVersion, canSearch, loader, query, source]);

  // Первый поиск без запроса — популярное под версию/загрузчик сборки.
  useEffect(() => {
    void runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // ───────────────────────── Установка ─────────────────────────

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
        // Мод-файлы всегда в mods/, имя — как у хостинга (оно уникально
        // и содержит версию, что удобно при откате).
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

    // Только обязательные зависимости и только с известным projectId:
    // без него резолвить нечего. Версия зависимости подбирается не из
    // `versionId` (он привязан к конкретной версии основного мода и
    // может не подойти к нашей MC/загрузчику), а свежая подходящая.
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
          // slug проекта-зависимости хостинг в этом ответе не отдаёт, но
          // modId нужен серверу, чтобы убрать прошлую версию зависимости
          // (иначе две версии одного мода в mods/). Выводим из имени файла
          // тем же правилом, что и при обычной загрузке.
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
          ? `, зависимости без подходящего файла: ${plan.skipped.join(", ")}`
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

  // ───────────────────────── Раскладка ─────────────────────────

  const dialogRef = useRef<HTMLDivElement>(null);
  useBodyScrollLock();
  useDialogFocus(dialogRef, () => {
    if (!installing) onClose();
  });

  const recommended = useMemo(
    () => versions?.find((v) => v.versionType === "release" && v.fileUrl),
    [versions],
  );

  // «Уже в сборке»: сравниваем slug мода с modId файлов и имена файлов в
  // mods/. У части старых файлов modId пуст, поэтому проверяем и имя.
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

  return (
    <div className="modal-backdrop" onClick={() => !installing && onClose()}>
      <div
        ref={dialogRef}
        className="modal modsearch"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modsearch-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modsearch-head">
          <div className="modsearch-head-title">
            {picked ? (
              <button
                className="icon-only ghost"
                aria-label="Назад к результатам"
                onClick={() => {
                  selectedRef.current = null;
                  setPicked(null);
                  setVersions(null);
                }}
              >
                <IconArrowLeft size={16} />
              </button>
            ) : (
              <IconPuzzle size={18} />
            )}
            <div>
              <h3 id="modsearch-title">
                {picked ? picked.title : "Поиск модов"}
              </h3>
              <p className="muted modsearch-sub">
                {picked
                  ? `${picked.author || "неизвестный автор"} · ${formatDownloads(picked.downloads)} загрузок`
                  : `${build.loaderKind} · MC ${build.mcVersion}`}
              </p>
            </div>
          </div>
          <button
            className="icon-only ghost"
            aria-label="Закрыть"
            onClick={onClose}
            disabled={installing}
          >
            <IconClose size={16} />
          </button>
        </div>

        {!canSearch ? (
          <div className="error">
            Поиск модов недоступен для загрузчика «{build.loaderKind}»: у
            Vanilla нет модов на Modrinth/CurseForge.
          </div>
        ) : picked ? (
          <VersionPicker
            versions={versions}
            loading={versionsLoading}
            error={versionsError}
            recommended={recommended}
            withDeps={withDeps}
            onWithDeps={setWithDeps}
            installing={installing}
            onInstall={(v) => void install(picked, v)}
          />
        ) : (
          <SearchStep
            source={source}
            onSource={(s) => {
              setSource(s);
              setHits(null);
            }}
            query={query}
            onQuery={setQuery}
            onSubmit={() => void runSearch()}
            searching={searching}
            error={searchError}
            hits={hits}
            loader={loader}
            mcVersion={build.mcVersion}
            isInstalled={isInstalled}
            onPick={(h) => void loadVersions(h)}
          />
        )}
      </div>
    </div>
  );
}

// ───────────────────────── Шаг 1: поиск ─────────────────────────

function SearchStep({
  source,
  onSource,
  query,
  onQuery,
  onSubmit,
  searching,
  error,
  hits,
  loader,
  mcVersion,
  isInstalled,
  onPick,
}: {
  source: ModSource;
  onSource: (s: ModSource) => void;
  query: string;
  onQuery: (v: string) => void;
  onSubmit: () => void;
  searching: boolean;
  error: string | null;
  hits: ModHit[] | null;
  loader?: string;
  mcVersion: string;
  isInstalled: (hit: ModHit) => boolean;
  onPick: (hit: ModHit) => void;
}) {
  return (
    <>
      <div className="modsearch-controls">
        <div className="modsearch-sources" role="tablist" aria-label="Источник модов">
          <button
            role="tab"
            aria-selected={source === "modrinth"}
            className={source === "modrinth" ? "active" : ""}
            onClick={() => onSource("modrinth")}
          >
            Modrinth
          </button>
          <button
            role="tab"
            aria-selected={source === "curseforge"}
            className={source === "curseforge" ? "active" : ""}
            onClick={() => onSource("curseforge")}
          >
            CurseForge
          </button>
        </div>
        <form
          className="modsearch-form"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <div className="search">
            <IconSearch />
            <input
              autoFocus
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder={`Название мода (${loader ?? "любой"} · ${mcVersion})`}
            />
          </div>
          <button className="primary" type="submit" disabled={searching}>
            {searching ? "Поиск…" : "Найти"}
          </button>
        </form>
      </div>

      {error && <div className="error">{error}</div>}
      {source === "curseforge" && error && (
        <p className="muted modsearch-hint">
          CurseForge требует API-ключ: «Настройки» → «CurseForge API Key».
        </p>
      )}

      <div className="modsearch-results" aria-busy={searching}>
        {hits === null && !searching && !error && (
          <p className="muted modsearch-empty">Введите запрос и нажмите «Найти».</p>
        )}
        {hits !== null && hits.length === 0 && (
          <p className="muted modsearch-empty">
            Ничего не найдено под {loader ?? "этот загрузчик"} и MC {mcVersion}.
          </p>
        )}
        {hits?.map((h) => (
          <button
            key={`${h.source}:${h.id}`}
            className={`modsearch-hit${isInstalled(h) ? " installed" : ""}`}
            onClick={() => onPick(h)}
          >
            {h.iconUrl ? (
              <img src={h.iconUrl} alt="" loading="lazy" />
            ) : (
              <span className="modsearch-hit-icon">
                <IconPuzzle size={18} />
              </span>
            )}
            <span className="modsearch-hit-body">
              <span className="modsearch-hit-title">
                {h.title}
                {isInstalled(h) && (
                  <span className="modsearch-type installed-tag">в сборке</span>
                )}
                <span className="modsearch-hit-author">{h.author}</span>
              </span>
              <span className="modsearch-hit-desc">{h.description}</span>
              <span className="modsearch-hit-meta">
                <IconDownload size={12} />
                {formatDownloads(h.downloads)}
                {h.categories.slice(0, 3).map((c) => (
                  <span key={c} className="modsearch-chip">{c}</span>
                ))}
              </span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

// ───────────────────────── Шаг 2: версия ─────────────────────────

function VersionPicker({
  versions,
  loading,
  error,
  recommended,
  withDeps,
  onWithDeps,
  installing,
  onInstall,
}: {
  versions: ModVersion[] | null;
  loading: boolean;
  error: string | null;
  recommended?: ModVersion;
  withDeps: boolean;
  onWithDeps: (v: boolean) => void;
  installing: boolean;
  onInstall: (v: ModVersion) => void;
}) {
  if (loading) return <p className="muted modsearch-empty">Загружаю версии…</p>;
  if (error) return <div className="error">{error}</div>;
  if (!versions || versions.length === 0) {
    return (
      <p className="muted modsearch-empty">
        Подходящих версий нет. Возможно, мод не поддерживает эту MC-версию
        или загрузчик.
      </p>
    );
  }

  return (
    <div className="modsearch-versions">
      <label className="modsearch-deps-toggle">
        <input
          type="checkbox"
          checked={withDeps}
          onChange={(e) => onWithDeps(e.target.checked)}
        />
        <span>Ставить обязательные зависимости автоматически</span>
      </label>

      <div className="modsearch-version-list">
        {versions.map((v) => {
          const primary = recommended?.id === v.id;
          const blocked = !v.fileUrl;
          return (
            <div
              key={v.id}
              className={`modsearch-version${primary ? " recommended" : ""}${blocked ? " blocked" : ""}`}
            >
              <div className="modsearch-version-main">
                <div className="modsearch-version-title">
                  <span>{v.name || v.versionNumber}</span>
                  <span className={`modsearch-type modsearch-type--${v.versionType}`}>
                    {typeLabel(v.versionType)}
                  </span>
                  {primary && <span className="modsearch-type recommended-tag">рекомендуется</span>}
                </div>
                <div className="modsearch-version-meta">
                  <span>{v.fileName}</span>
                  {v.fileSize > 0 && <span>{formatSize(v.fileSize)}</span>}
                  {v.datePublished && (
                    <span>{new Date(v.datePublished).toLocaleDateString("ru-RU")}</span>
                  )}
                  {v.dependencies.filter((d) => d.dependencyType === "required").length > 0 && (
                    <span className="modsearch-dep-count">
                      зависимостей:{" "}
                      {v.dependencies.filter((d) => d.dependencyType === "required").length}
                    </span>
                  )}
                </div>
                {blocked && (
                  <div className="modsearch-blocked">
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
    </div>
  );
}
