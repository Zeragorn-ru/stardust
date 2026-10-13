// Детали сборки (десктоп): шапка с действиями + файловый менеджер.
//
// Вся логика действий (активация, клон, удаление, SFTP-синхронизация,
// деплой мода, проверки, правки) — в ui/buildActions.ts (план 3.2);
// здесь только десктопная раскладка.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "./api";
import type { BuildDetail as BuildDetailData, BuildHeader } from "./types";
import { FileManager } from "./FileManager";
import { formatSize } from "./format";
import { EmptyPanel, ErrorPanel, LoadPanel } from "./ui/EmptyState";
import {
  ActiveBuildBadge,
  EditBuildModal,
  useBuildActions,
} from "./ui/buildActions";
import {
  IconCheck,
  IconClose,
  IconCopy,
  IconDownload,
  IconPencil,
  IconSync,
  IconTrash,
} from "./ui/icons";
import { CheckResults } from "./ui/CheckResults";

export function BuildDetail({
  buildId,
  onChanged,
}: {
  buildId: number;
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<BuildDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
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
    // Правки и активация меняют манифест — перечитываем и детали, и хаб.
    onChanged: async () => {
      await load();
      onChanged();
    },
    onDeleted: () => navigate("/builds"),
    onNavigate: (id) => navigate(`/builds/${id}`),
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

  if (loading) return <LoadPanel>Загрузка сборки…</LoadPanel>;

  if (!detail) {
    if (loadError) {
      return (
        <ErrorPanel title="Не удалось загрузить сборку" onRetry={() => void load()}>
          {loadError}
        </ErrorPanel>
      );
    }
    // 404: как в MobileBuildDetail — явная панель вместо пустого экрана.
    return (
      <EmptyPanel
        title="Сборка не найдена"
        action={
          <button className="secondary" onClick={() => navigate("/builds")}>
            К списку сборок
          </button>
        }
      >
        Возможно, она была удалена.
      </EmptyPanel>
    );
  }

  return (
    <div className="detail">
      <div className="panel detail-head-compact">
        <div className="detail-header-top">
          <div className="detail-title">
            <h2>{detail.name}</h2>
            <span className="detail-version muted">v{detail.version}</span>
            {/* Активация — полноценная primary-кнопка в тулбаре; бейдж — состояние. */}
            {detail.isActive && <ActiveBuildBadge />}
          </div>
          <div className="detail-actions-toolbar">
            {!detail.isActive && (
              <button
                className="primary compact"
                onClick={() => void actions.activate()}
                title="Сделать сборку активной — её скачают все игроки"
              >
                Сделать активной
              </button>
            )}
            <button
              className="secondary compact"
              onClick={() => setEditing(true)}
              title="Редактировать параметры сборки"
            >
              <IconPencil size={14} /> Редактировать
            </button>
            <button
              className="secondary compact"
              disabled={actions.busyClone}
              onClick={() => void actions.cloneBuild()}
              title="Создать копию сборки со всеми файлами"
            >
              <IconCopy size={14} /> Клонировать
            </button>
            <button
              className="secondary compact"
              disabled={actions.syncing}
              onClick={() => void actions.syncToPanel()}
              title="Загрузить серверные файлы сборки на сервер по SFTP"
            >
              <IconSync size={14} className={actions.syncing ? "spin" : ""} />
              {actions.syncing ? "Синхронизация…" : "Синхр. по SFTP"}
            </button>
            {detail.isActive ? (
              <button
                className="secondary compact"
                disabled={actions.deploying}
                onClick={() => void actions.deployMod()}
                title="Скачать мод из GitHub и добавить в сборку"
              >
                <IconDownload size={14} />
                {actions.deploying ? "Загрузка мода…" : "Обновить stardust-mod"}
              </button>
            ) : (
              // Мод добавляется только в активную сборку — на неактивной
              // показываем пассивную строку-ссылку на неё (план 3.2).
              <span className="detail-hint-link">
                Мод обновляется в активной сборке —{" "}
                <a
                  href={activeBuild ? `#/builds/${activeBuild.id}` : "#/builds"}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(activeBuild ? `/builds/${activeBuild.id}` : "/builds");
                  }}
                >
                  открыть её
                </a>
              </span>
            )}
            <button
              className="secondary compact"
              disabled={actions.checkResults.loading}
              onClick={() => void actions.runChecks()}
              title="Выполнить проверку файлов и зависимостей сборок"
            >
              <IconCheck size={14} />
              {actions.checkResults.loading ? "Проверка…" : "Проверить"}
            </button>
            <button
              className="danger compact"
              disabled={actions.busyDelete}
              onClick={() => void actions.removeBuild()}
              title="Удалить сборку"
            >
              <IconTrash size={14} /> Удалить
            </button>
          </div>
        </div>

        <div className="detail-meta-row">
          <span className="meta-item">
            <span className="meta-label">Загрузчик:</span>{" "}
            <strong>{detail.loaderKind}</strong>
          </span>
          <span className="meta-sep">·</span>
          <span className="meta-item">
            <span className="meta-label">Minecraft:</span>{" "}
            <strong>{detail.mcVersion}</strong>
          </span>
          {detail.loaderVersion && (
            <>
              <span className="meta-sep">·</span>
              <span className="meta-item">
                <span className="meta-label">Версия загрузчика:</span>{" "}
                <strong>{detail.loaderVersion}</strong>
              </span>
            </>
          )}
          <span className="meta-sep">·</span>
          <span className="meta-item">
            <span className="meta-label">Файлов:</span> <strong>{files.length}</strong>
          </span>
          <span className="meta-sep">·</span>
          <span className="meta-item">
            <span className="meta-label">Общий размер:</span>{" "}
            <strong>{formatSize(totalSize)}</strong>
          </span>
        </div>
      </div>

      {actions.syncStatus && actions.syncStatus.state !== "idle" && (
        <div
          className={`panel sync-progress sync-progress--${actions.syncStatus.state}`}
        >
          <div className="sync-progress__head">
            <strong>
              {actions.syncStatus.state === "running"
                ? "SFTP-синхронизация"
                : actions.syncStatus.state === "success"
                  ? "SFTP-синхронизация завершена"
                  : "SFTP-синхронизация с ошибкой"}
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
                  ? "Мод добавлен в сборку"
                  : "Ошибка загрузки мода"}
            </strong>
          </div>
          <div className="sync-progress__meta">
            <span>{actions.deployStatus.phase}</span>
            {actions.deployStatus.version && (
              <span>Версия: {actions.deployStatus.version}</span>
            )}
          </div>
          {actions.deployStatus.error && (
            <div className="q-err">{actions.deployStatus.error}</div>
          )}
        </div>
      )}

      {actions.checkResults.loading && (
        <div className="panel checks-loading">
          <span className="spinner" /> Выполняется проверка файлов и зависимостей
          сборки...
        </div>
      )}

      {(actions.checkResults.build || actions.checkResults.deps) &&
        !actions.checkResults.loading && (
          <div className="panel check-results-panel">
            <div className="check-results-header">
              <strong>
                <IconCheck size={14} /> Результаты проверки
              </strong>
              <button
                className="icon-only close-btn"
                title="Скрыть результаты"
                onClick={actions.clearCheckResults}
              >
                <IconClose size={14} />
              </button>
            </div>
            <CheckResults state={actions.checkResults} />
          </div>
        )}

      <div className="panel">
        <FileManager
          buildId={buildId}
          files={files}
          modProfiles={detail?.modProfiles ?? []}
          onChanged={load}
        />
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
