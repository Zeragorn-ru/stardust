// Поиск и установка модов (Modrinth / CurseForge) в сборку. Сервер скачивает
// файлы сам и регистрирует их по SHA-1; браузер байты не передаёт.

import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import type { InstallModRequest, ModHit, ModSource, ModVersion } from "../../types";
import {
  Button,
  Chip,
  EmptyState,
  Field,
  Modal,
  SearchInput,
  Select,
} from "../../ui/components";
import { useToast } from "../../ui/feedback";
import { formatSize } from "../../format";
import { IconCheck, IconDownload, IconSearch } from "../../ui/icons";

const PAGE_SIZE = 20;

export function ModSearch({
  buildId,
  mcVersion,
  loader,
  profiles,
  onInstalled,
}: {
  buildId: number;
  mcVersion: string;
  loader: string;
  /** Доступные профили опциональных модов (ключи). */
  profiles: string[];
  onInstalled: () => void;
}) {
  const toast = useToast();
  const [source, setSource] = useState<ModSource>("modrinth");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ModHit[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<{ hit: ModHit; versions: ModVersion[] } | null>(null);

  const search = useCallback(
    async (nextOffset: number) => {
      setSearching(true);
      setError(null);
      try {
        const res = await api.searchMods({
          source,
          query: query.trim(),
          loader,
          mcVersion,
          offset: nextOffset,
        });
        if (nextOffset === 0) setHits(res.hits);
        else setHits((cur) => {
          const list = cur ?? [];
          const seen = new Set(list.map((h) => `${h.source}:${h.id}`));
          return [...list, ...res.hits.filter((h) => !seen.has(`${h.source}:${h.id}`))];
        });
        setTotal(res.totalCount);
        setOffset(nextOffset);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Поиск не удался");
      } finally {
        setSearching(false);
      }
    },
    [source, query, loader, mcVersion],
  );

  // Первая страница при смене источника/запроса — по кнопке, не автоматом.
  // Но источник меняем — сбрасываем результаты.
  useEffect(() => {
    setHits(null);
    setTotal(0);
  }, [source]);

  return (
    <div className="mod-search">
      <div className="toolbar" style={{ marginBottom: "var(--s4)" }}>
        <Select
          value={source}
          onChange={(e) => setSource(e.target.value as ModSource)}
          aria-label="Источник"
          style={{ width: "160px" }}
        >
          <option value="modrinth">Modrinth</option>
          <option value="curseforge">CurseForge</option>
        </Select>
        <form
          className="row grow"
          onSubmit={(e) => {
            e.preventDefault();
            void search(0);
          }}
        >
          <SearchInput
            value={query}
            onValueChange={setQuery}
            placeholder={`Поиск на ${source === "modrinth" ? "Modrinth" : "CurseForge"}…`}
            className="grow"
          />
          <Button type="submit" icon={<IconSearch size={14} />} busy={searching}>
            Найти
          </Button>
        </form>
      </div>

      {error && <div className="error-panel">{error}</div>}

      {hits === null && !searching && !error && (
        <EmptyState
          title="Начните с поиска"
          body={`Введите название мода и нажмите «Найти». Учитывается Minecraft ${mcVersion} и загрузчик ${loader}.`}
        />
      )}
      {hits !== null && hits.length === 0 && !searching && (
        <EmptyState title="Ничего не найдено" body="Попробуйте другой запрос или источник." />
      )}

      {hits !== null && hits.length > 0 && (
        <div className="mod-list">
          {hits.map((hit) => (
            <ModRow
              key={`${hit.source}:${hit.id}`}
              hit={hit}
              onPick={async () => {
                try {
                  const res = await api.modVersions({
                    source: hit.source,
                    projectId: hit.id,
                    loader,
                    mcVersion,
                  });
                  setChoosing({ hit, versions: res.versions });
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Не удалось получить версии");
                }
              }}
            />
          ))}
          {hits.length < total && (
            <div className="row" style={{ justifyContent: "center", padding: "var(--s3)" }}>
              <Button busy={searching} onClick={() => void search(offset + PAGE_SIZE)}>
                Показать ещё ({total - hits.length})
              </Button>
            </div>
          )}
        </div>
      )}

      {choosing && (
        <VersionPicker
          buildId={buildId}
          hit={choosing.hit}
          versions={choosing.versions}
          mcVersion={mcVersion}
          loader={loader}
          profiles={profiles}
          onClose={() => setChoosing(null)}
          onInstalled={() => {
            setChoosing(null);
            onInstalled();
          }}
        />
      )}
    </div>
  );
}

function ModRow({ hit, onPick }: { hit: ModHit; onPick: () => void }) {
  return (
    <div className="mod-row">
      {hit.iconUrl ? (
        <img className="mod-icon" src={hit.iconUrl} alt="" loading="lazy" />
      ) : (
        <span className="mod-icon mod-icon-empty" aria-hidden="true" />
      )}
      <div className="grow ellipsis">
        <div className="row" style={{ gap: "var(--s2)" }}>
          <strong className="ellipsis">{hit.title}</strong>
          <span className="faint mono ellipsis">{hit.author}</span>
        </div>
        <div className="muted ellipsis" style={{ fontSize: "var(--fs-sm)" }}>
          {hit.description}
        </div>
      </div>
      <div className="row" style={{ gap: "var(--s2)", flex: "none" }}>
        <Chip title="Загрузок">{formatSize(hit.downloads)}</Chip>
        <Button size="sm" icon={<IconDownload size={14} />} onClick={onPick}>
          Установить
        </Button>
      </div>
    </div>
  );
}

function VersionPicker({
  buildId,
  hit,
  versions,
  profiles,
  onClose,
  onInstalled,
}: {
  buildId: number;
  hit: ModHit;
  versions: ModVersion[];
  mcVersion: string;
  loader: string;
  profiles: string[];
  onClose: () => void;
  onInstalled: () => void;
}) {
  const toast = useToast();
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "");
  const [optional, setOptional] = useState(false);
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const version = versions.find((v) => v.id === versionId) ?? null;

  async function install() {
    if (!version) return;
    setBusy(true);
    const request: InstallModRequest = {
      url: version.fileUrl ?? "",
      path: `mods/${version.fileName}`,
      kind: "mod",
      overwrite: true,
      optional,
      enabledByDefault: true,
      modId: hit.slug,
      displayName: hit.title,
      description: hit.description.slice(0, 200),
      ...(profile ? { profiles: [profile] } : {}),
    };
    try {
      const results = await api.installMods(buildId, [request]);
      const failed = results.filter((r) => r.error);
      if (failed.length > 0) {
        toast.error(`Не удалось установить: ${failed.map((f) => f.error).join("; ")}`);
      } else {
        toast.success(`${hit.title} установлен`);
      }
      onInstalled();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Установка не удалась");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Установка: ${hit.title}`} onClose={onClose}>
      {versions.length === 0 ? (
        <EmptyState
          title="Версий под эту сборку нет"
          body={`Для Minecraft/загрузчика этой сборки совпадений не найдено.`}
        />
      ) : (
        <div className="page-stack">
          <Field label="Версия мода">
            <Select value={versionId} onChange={(e) => setVersionId(e.target.value)}>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.versionNumber} — {v.versionType}
                  {v.fileUrl ? "" : " (файл недоступен)"}
                </option>
              ))}
            </Select>
          </Field>
          {version && (
            <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>
              {version.fileName} · {formatSize(version.fileSize)} · загрузок: {formatSize(version.downloads)}
            </div>
          )}
          <Field label="Опциональность" hint="Опциональные моды игрок включает/выключает сам">
            <Select value={optional ? "opt" : "core"} onChange={(e) => setOptional(e.target.value === "opt")}>
              <option value="core">Обязательный</option>
              <option value="opt">Опциональный</option>
            </Select>
          </Field>
          {optional && profiles.length > 0 && (
            <Field label="Профиль" hint="К какому пресету относится мод">
              <Select value={profile} onChange={(e) => setProfile(e.target.value)}>
                <option value="">Без профиля (общий)</option>
                {profiles.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {version?.dependencies.filter((d) => d.dependencyType === "required").length ? (
            <div className="stale-banner" style={{ borderRadius: "var(--radius)" }}>
              Требуемые зависимости будут доустановлены автоматически.
            </div>
          ) : null}
          <div className="row" style={{ justifyContent: "flex-end", gap: "var(--s2)" }}>
            <Button variant="ghost" onClick={onClose}>
              Отмена
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!version || !version.fileUrl}
              icon={<IconCheck size={14} />}
              onClick={install}
            >
              Установить
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
