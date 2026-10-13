// Детали сборки (мобильный): шапка с действиями + файловый менеджер.
//
// Слой данных и действий — общий ui/buildActions.ts (план 3.2), под телефон
// его адаптирует mobile.css. Здесь только мобильная шапка с переходом назад,
// крупными кнопками действий и панелями статуса рядом с ними. Удаление
// сборки тоже здесь: в списке на телефонах ≤390px иконки действий карточек
// скрыты, и без этой кнопки удалить сборку негде.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import type { BuildDetail as BuildDetailData, BuildHeader } from "../types";
import { FileManager } from "../FileManager";
import { formatSize } from "../format";
import { useToast } from "../ui/feedback";
import { EmptyPanel, ErrorPanel } from "../ui/EmptyState";
import {
  ActiveBuildBadge,
  EditBuildModal,
  useBuildActions,
} from "../ui/buildActions";
import { CheckResults } from "../ui/CheckResults";
import {
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconDownload,
  IconSync,
  IconTrash,
} from "../ui/icons";

type MobileBuildDetailProps = {
  buildId: number;
  onBack: () => void;
  onOpenBuild: (buildId: number) => void;
};

export function MobileBuildDetail({ buildId, onBack, onOpenBuild }: MobileBuildDetailProps) {
  const toast = useToast();

  const [detail, setDetail] = useState<BuildDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // Локальная занятость кнопки «Синхр. статистики»: паттерн общего
  // обработчика из обзора/аккаунтов (disabled + иконка), SFTP-синхронизация
  // занятости берётся из useBuildActions — отдельные состояния.
  const [syncingStats, setSyncingStats] = useState(false);
  // Какая сборка сейчас активная — для подсказки «Мод обновляется в
  // активной сборке — открыть её» на неактивных сборках.
  const [activeBuild, setActiveBuild] = useState<{ id: number; name: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [d, builds] = await Promise.all([
        api.getBuild(buildId),
        api.listBuilds().catch(() => [] as BuildHeader[]),
      ]);
      setDetail(d);
      const active = builds.find((b) => b.isActive);
      setActiveBuild(active ? { id: active.id, name: active.name } : null);
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

  const actions = useBuildActions(buildId, {
    detail,
    onChanged: load,
    onDeleted: onBack,
    onNavigate: onOpenBuild,
  });

  const files = detail?.files ?? [];
  const totalSize = useMemo(
    () => files.reduce((s, f) => s + f.sizeBytes, 0),
    [files],
  );
  const syncPercent = actions.syncStatus?.total
    ? Math.min(
        100,
        Math.round((actions.syncStatus.current / actions.syncStatus.total) * 100),
      )
    : 0;

  async function syncStats() {
    if (syncingStats) return;
    setSyncingStats(true);
    try {
      const res = await api.syncStats();
      toast.success(`Статистика обновлена: ${res.updated} игроков`);
      // Статистика влияет на панель проверок — перезагружаем детали.
      await load();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Ошибка синхронизации",
      );
    } finally {
      setSyncingStats(false);
    }
  }

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
          <ErrorPanel title="Не удалось загрузить сборку" onRetry={() => void load()}>
            {loadError}
          </ErrorPanel>
        ) : (
          // 404: панель с явным выходом к списку вместо голой строки.
          <EmptyPanel
            title="Сборка не найдена"
            action={
              <button className="secondary" onClick={onBack}>
                К списку сборок
              </button>
            }
          >
            Возможно, она была удалена.
          </EmptyPanel>
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
          {/* Активация — primary-кнопка (как было на mobile); бейдж — состояние. */}
          {detail.isActive ? (
            <ActiveBuildBadge />
          ) : (
            <button className="primary" onClick={() => void actions.activate()}>
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
            onClick={() => void actions.cloneBuild()}
            disabled={actions.busyClone}
          >
            <IconCopy size={15} /> {actions.busyClone ? "Копия…" : "Клонировать"}
          </button>
          <button
            className="secondary icon-btn"
            disabled={actions.syncing}
            onClick={() => void actions.syncToPanel()}
          >
            <IconSync size={15} className={actions.syncing ? "spin" : ""} />
            {actions.syncing ? "Синхр…" : "Синхр. на сервер"}
          </button>
          {detail.isActive ? (
            <button
              className="secondary icon-btn"
              disabled={actions.deploying}
              onClick={() => void actions.deployMod()}
            >
              <IconDownload size={15} />
              {actions.deploying ? "Загрузка мода…" : "Обновить stardust-mod"}
            </button>
          ) : (
            // Пассивная подсказка: мод обновляется только в активной сборке.
            <span className="detail-hint-link">
              Мод обновляется в активной сборке —{" "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  if (activeBuild) onOpenBuild(activeBuild.id);
                  else onBack();
                }}
              >
                открыть её
              </a>
            </span>
          )}
          <button
            className="danger icon-btn"
            onClick={() => void actions.removeBuild()}
            disabled={actions.busyDelete}
          >
            <IconTrash size={15} />{" "}
            {actions.busyDelete ? "Удаление…" : "Удалить"}
          </button>
        </div>
      </div>

      {/* Панели статуса — сразу под кнопками, выше статистики и файлового
          менеджера: кнопки «Синхр. на сервер» и «Обновить stardust-mod»
          вверху, и админ должен видеть прогресс там же, где нажал, а не
          после длинной простыни карточек и списка файлов. */}
      {actions.syncStatus && actions.syncStatus.state !== "idle" && (
        <div
          className={`panel sync-progress sync-progress--${actions.syncStatus.state}`}
        >
          <div className="sync-progress__head">
            <strong>
              {actions.syncStatus.state === "running"
                ? "SFTP-синхронизация"
                : actions.syncStatus.state === "success"
                  ? "SFTP завершён"
                  : "SFTP с ошибкой"}
            </strong>
            <span className="muted">{syncPercent}%</span>
          </div>
          <div className="progress sync-progress__bar">
            <div
              className="progress-bar"
              style={{ width: `${syncPercent}%` }}
            />
          </div>
          <div className="sync-progress__meta">
            <span>{actions.syncStatus.phase || "Ожидание"}</span>
            <span>
              {actions.syncStatus.current}/{actions.syncStatus.total || 1} ·
              загружено {actions.syncStatus.uploaded} · удалено{" "}
              {actions.syncStatus.deleted} · пропущено {actions.syncStatus.skipped}
            </span>
          </div>
          {actions.syncStatus.error && (
            <div className="q-err">{actions.syncStatus.error}</div>
          )}
        </div>
      )}

      {actions.deployStatus && (
        <div
          className={`panel sync-progress sync-progress--${
            actions.deployStatus.state === "success"
              ? "success"
              : actions.deployStatus.state === "error"
                ? "error"
                : "running"
          }`}
        >
          <div className="sync-progress__head">
            <strong>
              {actions.deployStatus.state === "running"
                ? "Загрузка мода"
                : actions.deployStatus.state === "success"
                  ? "Мод добавлен"
                  : "Ошибка загрузки"}
            </strong>
          </div>
          <div className="sync-progress__meta">
            <span>{actions.deployStatus.phase}</span>
            {actions.deployStatus.version && (
              <span>v{actions.deployStatus.version}</span>
            )}
          </div>
          {actions.deployStatus.error && (
            <div className="q-err">{actions.deployStatus.error}</div>
          )}
        </div>
      )}

      <div className="m-stats">
        <Stat label="Загрузчик" value={detail.loaderKind} />
        <Stat label="MC" value={detail.mcVersion} />
        <Stat label="Загрузчик v" value={detail.loaderVersion || "—"} />
        <Stat label="Файлов" value={String(files.length)} />
        <Stat label="Размер" value={formatSize(totalSize)} />
      </div>

      <div className="panel m-fm-panel">
        <FileManager
          buildId={buildId}
          files={files}
          modProfiles={detail?.modProfiles ?? []}
          onChanged={load}
        />
      </div>

      <div className="panel m-checks-panel">
        <div className="m-checks-head">
          <IconCheck size={16} />
          <strong>Проверки</strong>
          <button
            className="secondary"
            disabled={actions.checkResults.loading}
            onClick={() => void actions.runChecks()}
          >
            {actions.checkResults.loading ? "Проверка…" : "Проверить"}
          </button>
          <button
            className="secondary"
            disabled={syncingStats}
            onClick={() => void syncStats()}
            title="Синхронизировать статистику игроков из Minecraft"
          >
            <IconSync size={14} className={syncingStats ? "spin" : ""} />{" "}
            {syncingStats ? "Синхр…" : "Синхр. статистики"}
          </button>
        </div>
        <CheckResults state={actions.checkResults} />
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
          onSave={async (input) => {
            const ok = await actions.saveEdit(input);
            if (ok) setEditing(false);
          }}
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
