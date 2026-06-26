import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api";
import type { BuildDetail as BuildDetailData } from "./types";
import { FileManager } from "./FileManager";
import { formatSize } from "./format";
import { useToast } from "./ui/feedback";
import { IconStar } from "./ui/icons";

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
        err instanceof ApiError
          ? err.message
          : "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044c \u0441\u0431\u043e\u0440\u043a\u0443",
      );
    } finally {
      setLoading(false);
    }
  }, [buildId, toast]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  async function activate() {
    try {
      await api.activateBuild(buildId);
      toast.success(
        "\u0421\u0431\u043e\u0440\u043a\u0430 \u0430\u043a\u0442\u0438\u0432\u0438\u0440\u043e\u0432\u0430\u043d\u0430",
      );
      await load();
      onChanged();
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : "\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0430\u043a\u0442\u0438\u0432\u0438\u0440\u043e\u0432\u0430\u0442\u044c",
      );
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
        \u0417\u0430\u0433\u0440\u0443\u0437\u043a\u0430\u2026
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
          {detail.isActive ? (
            <span className="badge active">
              <IconStar size={12} />{" "}
              \u0430\u043a\u0442\u0438\u0432\u043d\u0430\u044f
            </span>
          ) : (
            <button className="primary" onClick={activate}>
              \u0421\u0434\u0435\u043b\u0430\u0442\u044c
              \u0430\u043a\u0442\u0438\u0432\u043d\u043e\u0439
            </button>
          )}
        </div>
        <div className="detail-stats">
          <Stat
            label="\u0417\u0430\u0433\u0440\u0443\u0437\u0447\u0438\u043a"
            value={detail.loaderKind}
          />
          <Stat label="Minecraft" value={detail.mcVersion} />
          <Stat
            label="\u0412\u0435\u0440\u0441\u0438\u044f \u0437\u0430\u0433\u0440\u0443\u0437\u0447\u0438\u043a\u0430"
            value={detail.loaderVersion || "\u2014"}
          />
          <Stat
            label="\u0424\u0430\u0439\u043b\u043e\u0432"
            value={String(files.length)}
          />
          <Stat
            label="\u041e\u0431\u0449\u0438\u0439 \u0440\u0430\u0437\u043c\u0435\u0440"
            value={formatSize(totalSize)}
          />
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
