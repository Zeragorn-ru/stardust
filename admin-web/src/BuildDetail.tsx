import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { SyncStatus } from "./api";
import type {
  BuildCheckResult,
  BuildDetail as BuildDetailData,
  CreateBuildInput,
  DepsCheckResult,
} from "./types";
import { FileManager } from "./FileManager";
import { formatSize } from "./format";
import { useToast, useConfirm } from "./ui/feedback";
import { useBodyScrollLock } from "./ui/useBodyScrollLock";
import { IconCheck, IconCopy, IconDownload, IconStar, IconSync } from "./ui/icons";
import { CheckResults } from "./ui/CheckResults";

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
  onClone,
}: {
  buildId: number;
  onChanged: () => void;
  // Необязательный обработчик клонирования: если задан, в шапке появляется
  // кнопка «Клонировать». Возвращает id созданной копии (для перехода).
  onClone?: (buildId: number) => void | Promise<void>;
}) {
  const toast = useToast();
  const confirm = useConfirm();
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
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const lastSyncState = useRef<SyncStatus["state"] | null>(null);
  const [editing, setEditing] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deployStatus, setDeployStatus] = useState<{
    state: string;
    phase: string;
    version: string | null;
    error: string | null;
  } | null>(null);

  const loadSyncStatus = useCallback(async () => {
    const status = await api.syncToPanelStatus(buildId);
    setSyncStatus(status);
    setSyncing(status.state === "running");
    return status;
  }, [buildId]);

  useEffect(() => {
    loadSyncStatus().catch(() => undefined);
  }, [loadSyncStatus]);

  useEffect(() => {
    if (syncStatus?.state !== "running") return;
    const timer = window.setInterval(async () => {
      try {
        const status = await loadSyncStatus();
        const prev = lastSyncState.current;
        if (prev === "running" && status.state === "success") {
          toast.success(
            `SFTP-синхронизация завершена: ${status.uploaded} файлов · удалено: ${status.deleted} · пропущено: ${status.skipped}`,
          );
        }
        if (prev === "running" && status.state === "error") {
          toast.error(status.error ?? "SFTP-синхронизация завершилась ошибкой");
        }
        lastSyncState.current = status.state;
      } catch {
        // Следующий polling-проход повторит попытку.
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [loadSyncStatus, syncStatus?.state, toast]);

  // --- Проверки ---
  const [checkResults, setCheckResults] = useState<{
    build: BuildCheckResult | null;
    deps: DepsCheckResult | null;
    loading: boolean;
  }>({ build: null, deps: null, loading: false });

  async function runChecks() {
    setCheckResults((s) => ({ ...s, loading: true }));
    try {
      const [build, deps] = await Promise.all([
        api.buildCheck(buildId),
        api.depsCheck(buildId),
      ]);
      setCheckResults({ build, deps, loading: false });
      const total = build.problems.length + deps.problems.length;
      if (total === 0) {
        toast.success("Проверки пройдены");
      } else {
        toast.error(`Найдено проблем: ${total}`);
      }
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось выполнить проверку",
      );
      setCheckResults((s) => ({ ...s, loading: false }));
    }
  }

  async function syncStats() {
    try {
      const res = await api.syncStats();
      toast.success(`Статистика обновлена: ${res.updated} игроков`);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Ошибка синхронизации",
      );
    }
  }

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
    let startedInBackground = false;
    try {
      const res = await api.syncToPanel(buildId);
      if (res.inProgress) {
        startedInBackground = true;
        lastSyncState.current = "running";
        await loadSyncStatus();
        toast.success("SFTP-синхронизация запущена в фоне");
      } else {
        toast.success(
          `Синхронизировано: ${res.uploaded} файлов · удалено: ${res.deleted} · пропущено: ${res.skipped}`,
        );
      }
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Ошибка синхронизации",
      );
    } finally {
      if (!startedInBackground) setSyncing(false);
    }
  }

  async function deployMod() {
    const ok = await confirm({
      title: "Добавить мод в сборку?",
      body: "Будет скачан последний релиз mod-v* из GitHub и добавлен в эту сборку. При следующей синхронизации мод попадёт на сервер.",
      confirmText: "Добавить",
    });
    if (!ok) return;

    setDeploying(true);
    setDeployStatus(null);
    try {
      await api.deployMod();
      const poll = setInterval(async () => {
        try {
          const s = await api.getDeployModStatus();
          setDeployStatus(s);
          if (s.state === "success" || s.state === "error") {
            clearInterval(poll);
            setDeploying(false);
            if (s.state === "success") {
              toast.success(`Мод ${s.version ?? "?"} добавлен в сборку. Синхронизируйте сервер.`);
              await load();
              onChanged();
            } else {
              toast.error(`Ошибка деплоя: ${s.error ?? "неизвестная ошибка"}`);
            }
          }
        } catch {
          clearInterval(poll);
          setDeploying(false);
        }
      }, 2000);
    } catch (err) {
      setDeploying(false);
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось запустить деплой мода",
      );
    }
  }

  const files = detail?.files ?? [];

  const totalSize = useMemo(
    () => files.reduce((s, f) => s + f.sizeBytes, 0),
    [files],
  );
  const syncPercent = syncStatus?.total
    ? Math.min(100, Math.round((syncStatus.current / syncStatus.total) * 100))
    : 0;

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
            {onClone && (
              <button
                className="secondary icon-btn"
                onClick={() => onClone(buildId)}
                title="Создать копию сборки со всеми файлами"
              >
                <IconCopy size={15} />
                Клонировать
              </button>
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
            <button
              className="secondary icon-btn"
              disabled={deploying}
              onClick={deployMod}
              title="Скачать мод из GitHub и добавить в сборку"
            >
              <IconDownload size={15} />
              {deploying ? "Загрузка мода…" : "Загрузить мод"}
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

      {syncStatus && syncStatus.state !== "idle" && (
        <div className={`panel sync-progress sync-progress--${syncStatus.state}`}>
          <div className="sync-progress__head">
            <strong>
              {syncStatus.state === "running"
                ? "SFTP-синхронизация"
                : syncStatus.state === "success"
                  ? "SFTP-синхронизация завершена"
                  : "SFTP-синхронизация с ошибкой"}
            </strong>
            <span className="muted">{syncPercent}%</span>
          </div>
          <div className="progress sync-progress__bar">
            <div className="progress-bar" style={{ width: `${syncPercent}%` }} />
          </div>
          <div className="sync-progress__meta">
            <span>{syncStatus.phase || "Ожидание"}</span>
            <span>
              {syncStatus.current}/{syncStatus.total || 1} · загружено {syncStatus.uploaded} · удалено {syncStatus.deleted} · пропущено {syncStatus.skipped}
            </span>
          </div>
          {syncStatus.error && <div className="q-err">{syncStatus.error}</div>}
        </div>
      )}

      <div className="panel">
        <FileManager buildId={buildId} files={files} onChanged={load} />
      </div>

      {deployStatus && (
        <div className={`panel sync-progress sync-progress--${deployStatus.state === "success" ? "success" : deployStatus.state === "error" ? "error" : "running"}`}>
          <div className="sync-progress__head">
            <strong>
              {deployStatus.state === "running"
                ? "Загрузка мода"
                : deployStatus.state === "success"
                  ? "Мод добавлен в сборку"
                  : "Ошибка загрузки мода"}
            </strong>
          </div>
          <div className="sync-progress__meta">
            <span>{deployStatus.phase}</span>
            {deployStatus.version && <span>Версия: {deployStatus.version}</span>}
          </div>
          {deployStatus.error && <div className="q-err">{deployStatus.error}</div>}
        </div>
      )}

      <div className="panel">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <IconCheck size={16} />
          <strong>Проверки</strong>
          <button
            className="secondary"
            style={{ marginLeft: "auto" }}
            disabled={checkResults.loading}
            onClick={runChecks}
          >
            {checkResults.loading ? "Проверка…" : "Проверить сборку"}
          </button>
          <button className="secondary" onClick={syncStats}>
            <IconSync size={14} /> Статистика
          </button>
        </div>
        <CheckResults state={checkResults} />
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
