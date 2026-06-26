import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { BuildDetail as BuildDetailData } from "./types";
import { FileUpload } from "./FileUpload";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function BuildDetail({
  buildId,
  onChanged,
}: {
  buildId: number;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<BuildDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetail(await api.getBuild(buildId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить сборку");
    } finally {
      setLoading(false);
    }
  }, [buildId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  async function activate() {
    try {
      await api.activateBuild(buildId);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось активировать");
    }
  }

  async function removeFile(fileId: number) {
    if (!confirm("Удалить файл из сборки?")) return;
    try {
      await api.deleteFile(fileId);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось удалить файл");
    }
  }

  if (loading) return <div className="panel muted">Загрузка…</div>;
  if (error && !detail) return <div className="error">{error}</div>;
  if (!detail) return null;

  return (
    <>
      <div className="panel">
        <div className="toolbar">
          <h2 style={{ margin: 0 }}>
            {detail.name} <span className="muted">v{detail.version}</span>
          </h2>
          {detail.isActive ? (
            <span className="badge active">активная</span>
          ) : (
            <button onClick={activate}>Сделать активной</button>
          )}
          <div className="spacer" />
          <span className="muted">
            {detail.loaderKind} · MC {detail.mcVersion}
            {detail.loaderVersion ? ` · ${detail.loaderVersion}` : ""}
          </span>
        </div>
        {error && <div className="error">{error}</div>}
        {detail.files.length === 0 ? (
          <p className="muted">В сборке пока нет файлов.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Путь</th>
                <th>Тип</th>
                <th>Сторона</th>
                <th>Размер</th>
                <th>Флаги</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {detail.files.map((f) => (
                <tr key={f.id}>
                  <td>
                    {f.path}
                    {f.displayName && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {f.displayName}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className="tag">{f.kind}</span>
                  </td>
                  <td className="muted">{f.side}</td>
                  <td className="num">{formatSize(f.sizeBytes)}</td>
                  <td>
                    {f.optional && <span className="tag">опц.</span>}{" "}
                    {!f.overwrite && <span className="tag">no-ow</span>}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button className="danger" onClick={() => removeFile(f.id)}>
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <FileUpload buildId={buildId} onUploaded={load} />
    </>
  );
}

export { formatSize };
