// Детали сборки (мобильный): шапка с действиями + файловый менеджер.
//
// Слой данных и сам FileManager переиспользуются с десктопа без изменений —
// под телефон их адаптирует mobile.css. Здесь только мобильная шапка с
// переходом назад и крупными кнопками действий.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { SyncStatus } from "../api";
import type {
  BuildCheckResult,
  BuildDetail as BuildDetailData,
  CreateBuildInput,
  DepsCheckResult,
} from "../types";
import { FileManager } from "../FileManager";
import { formatSize } from "../format";
import { useToast, useConfirm } from "../ui/feedback";
import { useBodyScrollLock } from "../ui/useBodyScrollLock";
import { CheckResults } from "../ui/CheckResults";
import {
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconStar,
  IconSync,
} from "../ui/icons";

const LOADERS = ["neoforge", "forge", "fabric", "quilt", "vanilla"];

type MobileBuildDetailProps = {
  buildId: number;
  onBack: () => void;
  onOpenBuild: (buildId: number) => void;
};

export function MobileBuildDetail({ buildId, onBack, onOpenBuild }: MobileBuildDetailProps) {
  const toast = useToast();
  const confirm = useConfirm();

  const [detail, setDetail] = useState<BuildDetailData | null>(null);
  const [loading, setLoading] = useState(true);
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
            `SFTP-синхронизация завершена: ${status.uploaded} · удалено ${status.deleted} · пропущено ${status.skipped}`,
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

  async function activate() {
    try {
      await api.activateBuild(buildId);
      toast.success("Сборка активирована");
      await load();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось активировать",
      );
    }
  }

  async function clone() {
    try {
      const res = await api.cloneBuild(buildId);
      toast.success("Создана копия");
      onOpenBuild(res.id);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось клонировать",
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
          `Синхронизировано: ${res.uploaded} · удалено: ${res.deleted} · пропущено: ${res.skipped}`,
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
      body: "Будет скачан последний релиз mod-v* из GitHub и добавлен в эту сборку.",
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
              toast.success(`Мод ${s.version ?? "?"} добавлен. Синхронизируйте сервер.`);
              await load();
            } else {
              toast.error(`Ошибка: ${s.error ?? "неизвестная"}`);
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
        err instanceof ApiError ? err.message : "Не удалось запустить деплой",
      );
    }
  }

  async function saveEdit(input: CreateBuildInput) {
    try {
      await api.updateBuild(buildId, input);
      toast.success("Сборка обновлена");
      setEditing(false);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Не удалось сохранить");
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
      <div className="m-screen">
        <MobileDetailHead onBack={onBack} title="Сборка" />
        <p className="muted pad">
          <span className="spinner" />
          Загрузка…
        </p>
      </div>
    );

  if (!detail)
    return (
      <div className="m-screen">
        <MobileDetailHead onBack={onBack} title="Сборка" />
        <p className="muted pad">Сборка не найдена.</p>
      </div>
    );

  return (
    <div className="m-screen">
      <MobileDetailHead
        onBack={onBack}
        title={detail.name}
        subtitle={`v${detail.version}`}
      />

      <div className="m-detail-actions">
        {detail.isActive ? (
          <span className="badge active">
            <IconStar size={12} /> активная
          </span>
        ) : (
          <button className="primary" onClick={activate}>
            Сделать активной
          </button>
        )}
        <button className="secondary" onClick={() => setEditing(true)}>
          Редактировать
        </button>
        <button className="secondary icon-btn" onClick={clone}>
          <IconCopy size={15} /> Клонировать
        </button>
        <button
          className="secondary icon-btn"
          disabled={syncing}
          onClick={syncToPanel}
        >
          <IconSync size={15} />
          {syncing ? "Синхр…" : "SFTP"}
        </button>
        <button
          className="secondary icon-btn"
          disabled={deploying}
          onClick={deployMod}
        >
          <IconDownload size={15} />
          {deploying ? "Мод…" : "Мод"}
        </button>
      </div>

      <div className="m-stats">
        <Stat label="Загрузчик" value={detail.loaderKind} />
        <Stat label="MC" value={detail.mcVersion} />
        <Stat label="Загрузчик v" value={detail.loaderVersion || "—"} />
        <Stat label="Файлов" value={String(files.length)} />
        <Stat label="Размер" value={formatSize(totalSize)} />
      </div>

      {syncStatus && syncStatus.state !== "idle" && (
        <div className={`panel sync-progress sync-progress--${syncStatus.state}`}>
          <div className="sync-progress__head">
            <strong>
              {syncStatus.state === "running"
                ? "SFTP-синхронизация"
                : syncStatus.state === "success"
                  ? "SFTP завершён"
                  : "SFTP с ошибкой"}
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

      <div className="panel m-fm-panel">
        <FileManager buildId={buildId} files={files} onChanged={load} />
      </div>

      {deployStatus && (
        <div className={`panel sync-progress sync-progress--${deployStatus.state === "success" ? "success" : deployStatus.state === "error" ? "error" : "running"}`}>
          <div className="sync-progress__head">
            <strong>
              {deployStatus.state === "running"
                ? "Загрузка мода"
                : deployStatus.state === "success"
                  ? "Мод добавлен"
                  : "Ошибка загрузки"}
            </strong>
          </div>
          <div className="sync-progress__meta">
            <span>{deployStatus.phase}</span>
            {deployStatus.version && <span>v{deployStatus.version}</span>}
          </div>
          {deployStatus.error && <div className="q-err">{deployStatus.error}</div>}
        </div>
      )}

      <div className="panel m-checks-panel">
        <div className="m-checks-head">
          <IconCheck size={16} />
          <strong>Проверки</strong>
          <button
            className="secondary"
            disabled={checkResults.loading}
            onClick={runChecks}
          >
            {checkResults.loading ? "Проверка…" : "Проверить"}
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

function MobileDetailHead({
  onBack,
  title,
  subtitle,
}: {
  onBack: () => void;
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="m-head m-detail-head">
      <button className="icon-only m-back" title="Назад" onClick={onBack}>
        <IconChevronRight size={22} className="flip" />
      </button>
      <div className="m-detail-titles">
        <h1>{title}</h1>
        {subtitle && <span className="muted">{subtitle}</span>}
      </div>
    </header>
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

  const valid = form.name.trim() && form.version.trim() && form.mcVersion.trim();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Редактировать сборку</h3>
        <div className="field">
          <label>Название</label>
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            autoFocus
          />
        </div>
        <div className="field">
          <label>Версия сборки</label>
          <input
            value={form.version}
            onChange={(e) => set("version", e.target.value)}
          />
        </div>
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
          />
        </div>
        <div className="field">
          <label>Версия загрузчика</label>
          <input
            value={form.loaderVersion}
            onChange={(e) => set("loaderVersion", e.target.value)}
          />
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
