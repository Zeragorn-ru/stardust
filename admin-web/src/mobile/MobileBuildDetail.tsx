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
  const [loadError, setLoadError] = useState<string | null>(null);
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
  // Опрос статуса деплоя мода: живёт в ref, чтобы пережить unmount и
  // не превращаться в утечку, если компонент закрыли до терминального статуса.
  const deployPollRef = useRef<number | null>(null);
  const deployPollErrors = useRef(0);

  function stopDeployPoll() {
    if (deployPollRef.current != null) {
      window.clearInterval(deployPollRef.current);
      deployPollRef.current = null;
    }
  }

  useEffect(() => stopDeployPoll, []);

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
    setLoading(true);
    setLoadError(null);
    try {
      setDetail(await api.getBuild(buildId));
    } catch (err) {
      // 404 — сборки нет, прочие ошибки — повторимая сетевая проблема.
      const notFound = err instanceof ApiError && err.status === 404;
      setDetail(null);
      setLoadError(
        notFound
          ? null
          : err instanceof ApiError
            ? err.message
            : "Не удалось загрузить сборку",
      );
    } finally {
      setLoading(false);
    }
  }, [buildId]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  async function activate() {
    if (!detail) return;
    const ok = await confirm({
      title: `Сделать сборку «${detail.name}» активной?`,
      body: `Все игроки при следующем запуске скачают именно её (v${detail.version}, ${files.length} файлов).`,
      confirmText: "Сделать активной",
    });
    if (!ok) return;
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

  const [busyClone, setBusyClone] = useState(false);

  async function clone() {
    if (busyClone) return;
    setBusyClone(true);
    try {
      const res = await api.cloneBuild(buildId);
      toast.success("Создана копия");
      onOpenBuild(res.id);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось клонировать",
      );
    } finally {
      setBusyClone(false);
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
      body: "Будет скачан последний релиз stardust-mod из GitHub и добавлен в эту сборку.",
      confirmText: "Добавить",
    });
    if (!ok) return;

    setDeploying(true);
    setDeployStatus(null);
    deployPollErrors.current = 0;
    try {
      await api.deployMod();
      stopDeployPoll();
      deployPollRef.current = window.setInterval(async () => {
        try {
          const s = await api.getDeployModStatus();
          deployPollErrors.current = 0;
          setDeployStatus(s);
          if (s.state === "success" || s.state === "error") {
            stopDeployPoll();
            setDeploying(false);
            if (s.state === "success") {
              toast.success(`Мод ${s.version ?? "?"} добавлен. Синхронизируйте сервер.`);
              await load();
            } else {
              toast.error(`Ошибка: ${s.error ?? "неизвестная"}`);
            }
          }
        } catch {
          // Одиночный сетевой сбой не должен убивать опрос: даём 5 попыток.
          deployPollErrors.current += 1;
          if (deployPollErrors.current >= 5) {
            stopDeployPoll();
            setDeploying(false);
            toast.error("Не удалось получить статус загрузки мода");
          }
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
        {loadError ? (
          <div className="panel pad">
            <p className="muted">{loadError}</p>
            <button className="secondary" onClick={() => void load()}>
              Повторить
            </button>
          </div>
        ) : (
          <p className="muted pad">Сборка не найдена.</p>
        )}
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
        <div className="m-detail-primary-action">
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
        <div className="m-detail-secondary-actions">
          <button className="secondary" onClick={() => setEditing(true)}>
            Редактировать
          </button>
          <button
            className="secondary icon-btn"
            onClick={clone}
            disabled={busyClone}
          >
            <IconCopy size={15} /> {busyClone ? "Копия…" : "Клонировать"}
          </button>
          <button
            className="secondary icon-btn"
            disabled={syncing}
            onClick={syncToPanel}
            title="Загрузить файлы сборки на сервер по SFTP"
          >
            <IconSync size={15} />
            {syncing ? "Синхр…" : "На сервер"}
          </button>
          <button
            className="secondary icon-btn"
            disabled={deploying}
            onClick={deployMod}
            title="Скачать stardust-mod из GitHub и добавить в сборку"
          >
            <IconDownload size={15} />
            {deploying ? "Мод…" : "Мод"}
          </button>
        </div>
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
          <button className="secondary" onClick={syncStats} title="Синхронизировать статистику игроков из Minecraft">
            <IconSync size={14} /> Синхр. статистики
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
  const confirm = useConfirm();
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);

  // Dirty в ref: обработчики Escape/клика по подложке видят актуальное
  // значение без пересоздания подписок.
  const dirty =
    form.name !== initial.name ||
    form.version !== initial.version ||
    form.loaderKind !== initial.loaderKind ||
    form.mcVersion !== initial.mcVersion ||
    form.loaderVersion !== initial.loaderVersion;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  async function tryClose() {
    if (busyRef.current) return;
    if (dirtyRef.current) {
      const ok = await confirm({
        title: "Есть несохранённые изменения",
        body: "Закрыть без сохранения?",
        confirmText: "Закрыть",
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") void tryClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <div className="modal-backdrop" onClick={() => void tryClose()}>
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
          <button type="button" onClick={() => void tryClose()} disabled={busy}>
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
