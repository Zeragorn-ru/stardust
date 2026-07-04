// Детали сборки (мобильный): шапка с действиями + файловый менеджер.
//
// Слой данных и сам FileManager переиспользуются с десктопа без изменений —
// под телефон их адаптирует mobile.css. Здесь только мобильная шапка с
// переходом назад и крупными кнопками действий.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import type {
  BuildCheckResult,
  BuildDetail as BuildDetailData,
  CreateBuildInput,
  DepsCheckResult,
} from "../types";
import { FileManager } from "../FileManager";
import { formatSize } from "../format";
import { useToast } from "../ui/feedback";
import { useBodyScrollLock } from "../ui/useBodyScrollLock";
import { CheckResults } from "../ui/CheckResults";
import {
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconStar,
  IconSync,
} from "../ui/icons";

const LOADERS = ["neoforge", "forge", "fabric", "quilt", "vanilla"];

export function MobileBuildDetail() {
  const params = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const buildId = Number(params.id);

  const [detail, setDetail] = useState<BuildDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState(false);

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
      navigate(`/builds/${res.id}`);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось клонировать",
      );
    }
  }

  async function syncToPanel() {
    setSyncing(true);
    try {
      const res = await api.syncToPanel(buildId);
      if (res.inProgress) {
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
      setSyncing(false);
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

  if (loading)
    return (
      <div className="m-screen">
        <MobileDetailHead onBack={() => navigate("/builds")} title="Сборка" />
        <p className="muted pad">
          <span className="spinner" />
          Загрузка…
        </p>
      </div>
    );

  if (!detail)
    return (
      <div className="m-screen">
        <MobileDetailHead onBack={() => navigate("/builds")} title="Сборка" />
        <p className="muted pad">Сборка не найдена.</p>
      </div>
    );

  return (
    <div className="m-screen">
      <MobileDetailHead
        onBack={() => navigate("/builds")}
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
      </div>

      <div className="m-stats">
        <Stat label="Загрузчик" value={detail.loaderKind} />
        <Stat label="MC" value={detail.mcVersion} />
        <Stat label="Загрузчик v" value={detail.loaderVersion || "—"} />
        <Stat label="Файлов" value={String(files.length)} />
        <Stat label="Размер" value={formatSize(totalSize)} />
      </div>

      <div className="panel m-fm-panel">
        <FileManager buildId={buildId} files={files} onChanged={load} />
      </div>

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
