import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api";
import type { BuildDetail as BuildDetailData } from "./types";
import { FileManager } from "./FileManager";
import { formatSize } from "./format";
import { useToast } from "./ui/feedback";
import { IconStar, IconSync } from "./ui/icons";

export function BuildDetail({
  buildId,
  onChanged,
}: {
  buildId: number;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [detail, setDetail] = useState<BuildDetailData | null>(null);
  const [loading, setLoading] = useState(true);

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
    load();
  }, [load]);

  const [syncing, setSyncing] = useState(false);

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

  async function syncToPanel() {
    setSyncing(true);
    try {
      const res = await api.syncToPanel(buildId);
      toast.success(
        `Синхронизировано: ${res.uploaded} файлов · удалено: ${res.deleted} · пропущено: ${res.skipped}`,
      );
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Ошибка синхронизации",
      );
    } finally {
      setSyncing(false);
    }
  }

  const files = detail?.files ?? [];

  const totalSize = useMemo(
    () => files.reduce((s, f) => s + f.sizeBytes, 0),
    [files],
  );

  if (loading)
    return (
      <div className="panel muted">
        <span className="spinner" />
        Загрузка…
      </div>
    );
  if (!detail) return null;

  return (
    <div className="detail">
      <div className="panel detail-head">
        <div className="detail-title">
          <h1>
            {detail.name} <span className="muted">v{detail.version}</span>
          </h1>
          <div className="detail-actions">
            {!detail.isActive && (
              <button className="primary" onClick={activate}>
                Сделать активной
              </button>
            )}
            {detail.isActive && (
              <span className="badge active">
                <IconStar size={12} /> активная
              </span>
            )}
            <button
              className="secondary icon-btn"
              disabled={syncing}
              onClick={syncToPanel}
              title="Загрузить серверные файлы сборки на сервер по SFTP"
            >
              <IconSync size={15} />
              {syncing ? "Синхронизация…" : "Синхр. по SFTP"}
            </button>
          </div>
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
        <FileManager buildId={buildId} files={files} onChanged={load} />
      </div>
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
