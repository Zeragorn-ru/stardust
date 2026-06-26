import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api";
import type { BuildDetail as BuildDetailData, BuildFile } from "./types";
import { FileUpload } from "./FileUpload";
import { formatSize, shortSha } from "./format";
import { useConfirm, useToast } from "./ui/feedback";
import { IconSearch, IconStar, IconTrash } from "./ui/icons";

const KIND_FILTERS = ["all", "mod", "config", "resource", "other"];

export function BuildDetail({
  buildId,
  onChanged,
}: {
  buildId: number;
  onChanged: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [detail, setDetail] = useState<BuildDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("all");

  const load = useCallback(async () => {
    try {
      setDetail(await api.getBuild(buildId));
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось загрузить сборку",
      );
    } finally {
      setLoading(false);
    }
  }, [buildId, toast]);

  useEffect(() => {
    setLoading(true);
    setQuery("");
    setKindFilter("all");
    load();
  }, [load]);

  async function activate() {
    try {
      await api.activateBuild(buildId);
      toast.success("Сборка активирована");
      await load();
      onChanged();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось активировать",
      );
    }
  }

  async function removeFile(f: BuildFile) {
    const ok = await confirm({
      title: "Удалить файл?",
      body: f.path,
      confirmText: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteFile(f.id);
      toast.success("Файл удалён");
      await load();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось удалить файл",
      );
    }
  }

  const files = detail?.files ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files.filter((f) => {
      if (kindFilter !== "all" && f.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        f.path.toLowerCase().includes(q) ||
        (f.displayName?.toLowerCase().includes(q) ?? false) ||
        (f.modId?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [files, query, kindFilter]);

  const totalSize = useMemo(
    () => files.reduce((s, f) => s + f.sizeBytes, 0),
    [files],
  );

  if (loading) return <div className="panel muted">Загрузка…</div>;
  if (!detail) return null;

  return (
    <div className="detail">
      <div className="panel detail-head">
        <div className="detail-title">
          <h1>
            {detail.name} <span className="muted">v{detail.version}</span>
          </h1>
          {detail.isActive ? (
            <span className="badge active">
              <IconStar size={12} /> активная
            </span>
          ) : (
            <button className="primary" onClick={activate}>
              Сделать активной
            </button>
          )}
        </div>
        <div className="detail-stats">
          <Stat label="Загрузчик" value={detail.loaderKind} />
          <Stat label="Minecraft" value={detail.mcVersion} />
          <Stat label="Версия загрузчика" value={detail.loaderVersion || "—"} />
          <Stat label="Файлов" value={String(files.length)} />
          <Stat label="Общий размер" value={formatSize(totalSize)} />
        </div>
      </div>

      <div className="panel">
        <div className="files-toolbar">
          <h2>Файлы</h2>
          <div className="spacer" />
          <div className="seg">
            {KIND_FILTERS.map((k) => (
              <button
                key={k}
                className={`seg-btn${kindFilter === k ? " active" : ""}`}
                onClick={() => setKindFilter(k)}
              >
                {k === "all" ? "все" : k}
              </button>
            ))}
          </div>
          <div className="search">
            <IconSearch />
            <input
              placeholder="Поиск по пути или имени"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        {files.length === 0 ? (
          <p className="muted">В сборке пока нет файлов. Загрузите их ниже.</p>
        ) : filtered.length === 0 ? (
          <p className="muted">Ничего не найдено.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Путь</th>
                <th>Тип</th>
                <th>Сторона</th>
                <th>sha1</th>
                <th className="num">Размер</th>
                <th>Флаги</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((f) => (
                <tr key={f.id}>
                  <td>
                    <div className="path">{f.path}</div>
                    {(f.displayName || f.description) && (
                      <div className="muted sub">
                        {f.displayName}
                        {f.displayName && f.description ? " — " : ""}
                        {f.description}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={`tag kind-${f.kind}`}>{f.kind}</span>
                  </td>
                  <td className="muted">{f.side}</td>
                  <td className="mono muted" title={f.sha1}>
                    {shortSha(f.sha1)}
                  </td>
                  <td className="num">{formatSize(f.sizeBytes)}</td>
                  <td>
                    <div className="flags">
                      {f.optional && (
                        <span className="tag">
                          опц.{f.enabledByDefault ? "✓" : "✗"}
                        </span>
                      )}
                      {!f.overwrite && <span className="tag">no-ow</span>}
                      {f.modId && (
                        <span className="tag mono" title="mod id">
                          {f.modId}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="row-actions">
                    <button
                      className="danger icon-only"
                      title="Удалить файл"
                      onClick={() => removeFile(f)}
                    >
                      <IconTrash size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <FileUpload buildId={buildId} onUploaded={load} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
