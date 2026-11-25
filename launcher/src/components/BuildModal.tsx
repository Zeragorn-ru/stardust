import { useCallback, useEffect, useRef, useState } from "react";
import type { ShaderSearchHit, ShaderVersion } from "../types";
import { downloadShader, listShaderVersions, searchShaders } from "../api";
import { formatBytes } from "../format";
import Aurora from "./Aurora";
import ModsSection from "./ModsSection";
import { CrashHistoryPanel } from "./CrashHistoryModal";

export type BuildTab = "mods" | "crashes" | "shaders";

const TABS: { id: BuildTab; label: string }[] = [
  { id: "mods", label: "Моды" },
  { id: "crashes", label: "Краши" },
  { id: "shaders", label: "Шейдеры" },
];

interface Props {
  initialTab?: BuildTab;
  onClose: () => void;
}

/**
 * Экран «Сборка» с главного экрана: моды (переехали из настроек),
 * история крашей и скачивание шейдерпаков с Modrinth.
 * Полноэкранный слой в стилистике настроек (.settings): шапка сверху,
 * навигация по вкладкам — боковая. Escape закрывает, когда ничего не грузится.
 */
export default function BuildModal({ initialTab = "mods", onClose }: Props) {
  const [tab, setTab] = useState<BuildTab>(initialTab);
  // Что-то грузится во вкладке шейдеров — блокируем случайное закрытие.
  const [shadersBusy, setShadersBusy] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (shadersBusy) return;
      onCloseRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shadersBusy]);

  return (
    <div
      className="settings build-screen"
      role="dialog"
      aria-modal="true"
      aria-label="Сборка"
    >
      <Aurora />
      <header className="settings__header" data-tauri-drag-region="deep">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onClose}
          disabled={shadersBusy}
        >
          ← Назад
        </button>
        <h2>Сборка</h2>
      </header>

      <div className="settings__layout">
        <nav className="settings__nav" aria-label="Разделы сборки">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={
                "settings__nav-item" +
                (tab === t.id ? " settings__nav-item--active" : "")
              }
              aria-current={tab === t.id ? "true" : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="settings__body build-screen__body">
          {tab === "mods" && <ModsSection />}
          {tab === "crashes" && <CrashHistoryPanel />}
          {tab === "shaders" && <ShadersPanel onBusyChange={setShadersBusy} />}
        </div>
      </div>
    </div>
  );
}

/** Состояние скачивания одного файла: ключ — url файла. */
type DownloadState = "idle" | "loading" | "done" | "error";

/**
 * Поиск и скачивание шейдерпаков с Modrinth. Пустой запрос — топ по
 * загрузкам. Файл кладётся бэкендом в папку shaderpacks активной сборки.
 */
function ShadersPanel({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ShaderSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // Раскрытый шейдерпак и его версии.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [versions, setVersions] = useState<ShaderVersion[] | null>(null);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  // Скачивание: url → состояние; после успеха файл помечаем навсегда.
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadedNote, setDownloadedNote] = useState(false);
  // Номер текущего поискового запроса: устаревший ответ не перезаписывает свежий.
  const searchSeqRef = useRef(0);

  const busy =
    searching || versionsLoading || Object.values(downloads).includes("loading");
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  // Debounce поиска: 400 мс после последнего нажатия.
  useEffect(() => {
    const q = query.trim();
    const timer = window.setTimeout(() => {
      const seq = ++searchSeqRef.current;
      setSearching(true);
      setSearchError(null);
      searchShaders(q || undefined)
        .then((list) => {
          if (seq !== searchSeqRef.current) return;
          setResults(list);
          // Свернувшийся результат закрывает и список версий.
          setExpandedId((id) => (id && list.some((r) => r.projectId === id) ? id : null));
        })
        .catch((reason) => {
          if (seq !== searchSeqRef.current) return;
          setResults(null);
          setSearchError(reason instanceof Error ? reason.message : String(reason));
        })
        .finally(() => {
          if (seq === searchSeqRef.current) setSearching(false);
        });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [query]);

  async function toggleVersions(hit: ShaderSearchHit) {
    if (expandedId === hit.projectId) {
      setExpandedId(null);
      setVersions(null);
      setVersionsError(null);
      return;
    }
    setExpandedId(hit.projectId);
    setVersions(null);
    setVersionsError(null);
    setVersionsLoading(true);
    try {
      const list = await listShaderVersions(hit.projectId);
      setVersions(list);
    } catch (reason) {
      setVersionsError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setVersionsLoading(false);
    }
  }

  const download = useCallback(async (url: string, filename: string) => {
    setDownloads((prev) => ({ ...prev, [url]: "loading" }));
    setDownloadError(null);
    try {
      await downloadShader(url, filename);
      setDownloads((prev) => ({ ...prev, [url]: "done" }));
      setDownloadedNote(true);
    } catch (reason) {
      setDownloads((prev) => ({ ...prev, [url]: "error" }));
      setDownloadError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  /** Основной файл версии: primary, иначе единственный. */
  function pickFile(version: ShaderVersion) {
    return version.files.find((f) => f.primary) ?? version.files[0] ?? null;
  }

  return (
    <div className="shaders-panel">
      <input
        type="text"
        className="input shaders-panel__search"
        placeholder="Поиск шейдерпаков на Modrinth…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {downloadedNote && (
        <p className="shaders-panel__note" role="status">
          Шейдерпак появился в папке shaderpacks — выбери его в настройках игры
          (OptiFine/Iris).
        </p>
      )}
      {searchError && (
        <p className="muted shaders-panel__error" role="alert">Ошибка поиска: {searchError}</p>
      )}
      {downloadError && (
        <p className="muted shaders-panel__error" role="alert">Ошибка скачивания: {downloadError}</p>
      )}

      {results === null && !searchError && (
        <p className="muted shaders-panel__state">
          <span className="spinner" /> {searching ? "Ищем шейдерпаки…" : "Загрузка…"}
        </p>
      )}

      {results !== null && results.length === 0 && (
        <p className="muted shaders-panel__state">
          {query.trim() ? `По запросу «${query.trim()}» ничего не найдено.` : "Список пуст."}
        </p>
      )}

      {results !== null && results.length > 0 && (
        <ul className="shaders-list">
          {results.map((hit) => {
            const expanded = expandedId === hit.projectId;
            const initial = hit.title.trim().slice(0, 1).toUpperCase() || "?";
            return (
              <li key={hit.projectId} className="shaders-list__item">
                <button
                  type="button"
                  className="shader-row"
                  aria-expanded={expanded}
                  onClick={() => void toggleVersions(hit)}
                >
                  <span className="shader-row__icon" aria-hidden="true">
                    {hit.iconUrl ? (
                      <img src={hit.iconUrl} alt="" loading="lazy" />
                    ) : (
                      initial
                    )}
                  </span>
                  <span className="shader-row__text">
                    <span className="shader-row__title">{hit.title}</span>
                    <span className="muted shader-row__desc">{hit.description}</span>
                  </span>

                  <span className="shader-row__chevron" aria-hidden>{expanded ? "▾" : "▸"}</span>
                </button>

                {expanded && (
                  <div className="shader-versions">
                    {versionsLoading && (
                      <p className="muted shader-versions__state">
                        <span className="spinner" /> Загружаем версии…
                      </p>
                    )}
                    {versionsError && (
                      <p className="muted shader-versions__state" role="alert">
                        Не удалось загрузить версии: {versionsError}
                      </p>
                    )}
                    {versions !== null && versions.length === 0 && (
                      <p className="muted shader-versions__state">Версий нет.</p>
                    )}
                    {versions !== null && versions.map((version) => {
                      const file = pickFile(version);
                      if (!file) return null;
                      const state = downloads[file.url] ?? "idle";
                      return (
                        <div key={version.id} className="shader-version">
                          <span className="shader-version__info">
                            <span className="shader-version__num">{version.versionNumber}</span>
                            <span className="muted shader-version__gc">
                              {version.gameVersions.slice(0, 3).join(", ")}
                              {version.gameVersions.length > 3 ? " и др." : ""}
                              {" · "}
                              {formatBytes(file.size)}
                            </span>
                          </span>
                          <button
                            type="button"
                            className="btn btn--ghost shader-version__btn"
                            disabled={state === "loading" || state === "done" || busy}
                            onClick={() => void download(file.url, file.filename)}
                          >
                            {state === "loading"
                              ? <span className="spinner" />
                              : state === "done"
                                ? "Скачано ✓"
                                : "Скачать"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
