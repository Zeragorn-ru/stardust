import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "./api";
import type { BuildDetail as BuildDetailData, CreateBuildInput } from "./types";
import { FileManager } from "./FileManager";
import { formatSize } from "./format";
import { useToast } from "./ui/feedback";
import { useBodyScrollLock } from "./ui/useBodyScrollLock";
import { IconStar, IconSync } from "./ui/icons";

const LOADERS = ["neoforge", "forge", "fabric", "quilt", "vanilla"];

function EditBuildModal({
  initial,
  onSave,
  onClose,
}: {
  initial: CreateBuildInput;
  onSave: (input: CreateBuildInput) => Promise<void>;
  onClose: () => void;
}) {
  useBodyScrollLock();
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function set<K extends keyof CreateBuildInput>(k: K, v: CreateBuildInput[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(form);
    } finally {
      setBusy(false);
    }
  }

  const valid =
    form.name.trim() && form.version.trim() && form.mcVersion.trim();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal modal-wide"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Редактировать сборку</h3>
        <div className="row">
          <div className="field">
            <label>Название</label>
            <input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              autoFocus
              placeholder="Моя сборка"
            />
          </div>
          <div className="field">
            <label>Версия сборки</label>
            <input
              value={form.version}
              onChange={(e) => set("version", e.target.value)}
              placeholder="1.0.0"
            />
          </div>
        </div>
        <div className="row">
          <div className="field">
            <label>Загрузчик</label>
            <select
              value={form.loaderKind}
              onChange={(e) => set("loaderKind", e.target.value)}
            >
              {LOADERS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Версия Minecraft</label>
            <input
              value={form.mcVersion}
              onChange={(e) => set("mcVersion", e.target.value)}
              placeholder="1.21.1"
            />
          </div>
          <div className="field">
            <label>Версия загрузчика</label>
            <input
              value={form.loaderVersion}
              onChange={(e) => set("loaderVersion", e.target.value)}
              placeholder="напр. 21.1.72"
            />
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" type="submit" disabled={busy || !valid}>
            {busy ? "Сохранение…" : "Сохранить"}
          </button>
        </div>
      </form>
    </div>
  );
}

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
  const [editing, setEditing] = useState(false);

  async function saveEdit(input: CreateBuildInput) {
    try {
      await api.updateBuild(buildId, input);
      toast.success("Сборка обновлена");
      setEditing(false);
      await load();
      onChanged();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось сохранить",
      );
    }
  }

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
            <button className="secondary" onClick={() => setEditing(true)}>
              Редактировать
            </button>
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

      {editing && (
        <EditBuildModal
          initial={{
            name: detail.name,
            version: detail.version,
            loaderKind: detail.loaderKind,
            mcVersion: detail.mcVersion,
            loaderVersion: detail.loaderVersion,
          }}
          onSave={saveEdit}
          onClose={() => setEditing(false)}
        />
      )}
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
