// Общий слой действий сборки (план 3.2, шаг 4).
//
// Раньше activate/clone/removeBuild/syncToPanel/deployMod/runChecks/saveEdit
// и опросы статусов были построчными копиями в BuildDetail.tsx (~650 строк)
// и mobile/MobileBuildDetail.tsx (~650 строк), EditBuildModal дублировался,
// LOADERS существовал в трёх файлах. Теперь логика живёт здесь, а оба шелла
// (десктоп /builds/:id и мобильные детали) оставляют только раскладку.
//
// Это же — точка входа для будущих действий сборки (promote pre-release →
// release, флаг канала): новое действие добавляется в хук один раз и
// появляется в обоих шеллах.

import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncStatus } from "../api";
import { api, ApiError } from "../api";
import type {
  BuildCheckResult,
  CreateBuildInput,
  DepsCheckResult,
} from "../types";
import { useConfirm, useToast } from "./feedback";
import { useBodyScrollLock } from "./useBodyScrollLock";
import { useDialogFocus } from "./useDialogFocus";
import { useDirtyGuard } from "./useDirtyGuard";
import { Field, FieldInput } from "./Field";
import { IconStar } from "./icons";

/** Варианты загрузчика для форм создания/редактирования сборки. */
export const LOADERS = ["neoforge", "forge", "fabric", "quilt", "vanilla"];

// ───────────────────────── Хук действий ─────────────────────────

export interface UseBuildActionsOptions {
  /**
   * Детали сборки (для текстов подтверждений). Пока сборка не загружена,
   * действия просто не выполняются — как было в обоих шеллах.
   */
  detail: { name: string; version: string; files: unknown[]; isActive: boolean } | null;
  /** Перезагрузить детали после изменившего сборку действия. */
  onChanged?: () => void | Promise<void>;
  /** Действие удалило сборку — уйти с экрана. */
  onDeleted?: () => void;
  /** Переход на другую сборку (после клонирования). */
  onNavigate: (buildId: number) => void;
}

export interface BuildActions {
  /** Установлена ли текущая синхронизация (крутится иконка, кнопка занята). */
  syncing: boolean;
  /** Последний статус SFTP-синхронизации (null — idle/скрыт). */
  syncStatus: SyncStatus | null;
  /** Идёт ли деплой мода (кнопка занята, опрос каждые 2 с). */
  deploying: boolean;
  /** Статус деплоя мода для панели прогресса. */
  deployStatus: DeployModStatus | null;
  /** Результаты проверок (файлы + зависимости). */
  checkResults: CheckResultsState;
  /** Клонирование запрошено (кнопка занята). */
  busyClone: boolean;
  /** Удаление запрошено (кнопка занята). */
  busyDelete: boolean;
  /** Сделать сборку активной (с существующим подтверждением). */
  activate: () => Promise<void>;
  /** Создать копию и открыть её. */
  cloneBuild: () => Promise<void>;
  /** Удалить сборку (danger-подтверждение) и уйти со списка. */
  removeBuild: () => Promise<void>;
  /** Запустить SFTP-синхронизацию; фоновая — подхватывается опросом. */
  syncToPanel: () => Promise<void>;
  /** Скачать последний релиз stardust-mod в АКТИВНУЮ сборку. */
  deployMod: () => Promise<void>;
  /** Выполнить проверки файлов и зависимостей. */
  runChecks: () => Promise<void>;
  /** Сохранить правки параметров сборки; true — успех (модалку можно закрыть). */
  saveEdit: (input: CreateBuildInput) => Promise<boolean>;
  /** Загрузить статус SFTP-синхронизации; adoptFinished=false — режим
   *  начальной загрузки (терминальные статусы прошлых визитов не подхватываем). */
  loadSyncStatus: (adoptFinished?: boolean) => Promise<SyncStatus>;
  /** Скрыть панели результатов проверок. */
  clearCheckResults: () => void;
}

/** Статус деплоя мода (api.getDeployModStatus). */
export interface DeployModStatus {
  state: string;
  phase: string;
  version: string | null;
  error: string | null;
}

/** Результаты проверок для CheckResults (ui/CheckResults.tsx). */
export interface CheckResultsState {
  build: BuildCheckResult | null;
  deps: DepsCheckResult | null;
  loading: boolean;
}

/**
 * Все действия сборки для обоих шеллов. Один слой данных — две раскладки.
 *
 * Опросы:
 *  - SFTP-синхронизация: раз в 1 с, пока state === "running";
 *  - деплой мода: раз в 2 с после запуска, 5 попыток на сетевые сбои,
 *    интервал живёт в ref и переживает unmount (см. stopDeployPoll).
 */
export function useBuildActions(
  buildId: number,
  {
    detail,
    onChanged,
    onDeleted,
    onNavigate,
  }: UseBuildActionsOptions,
): BuildActions {
  const toast = useToast();
  const confirm = useConfirm();

  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const lastSyncState = useRef<SyncStatus["state"] | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployStatus, setDeployStatus] = useState<DeployModStatus | null>(null);
  // Опрос статуса деплоя мода: живёт в ref, чтобы пережить unmount и
  // не превращаться в утечку, если уйти со страницы до терминального статуса.
  const deployPollRef = useRef<number | null>(null);
  const deployPollErrors = useRef(0);
  const [checkResults, setCheckResults] = useState<CheckResultsState>({
    build: null,
    deps: null,
    loading: false,
  });
  const [busyClone, setBusyClone] = useState(false);
  const [busyDelete, setBusyDelete] = useState(false);

  // Колбэки в ref: действия читают актуальные обработчики без пересоздания.
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const onDeletedRef = useRef(onDeleted);
  onDeletedRef.current = onDeleted;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  function stopDeployPoll() {
    if (deployPollRef.current != null) {
      window.clearInterval(deployPollRef.current);
      deployPollRef.current = null;
    }
  }

  useEffect(() => stopDeployPoll, []);

  // adoptFinished=false — режим начальной загрузки: бэкенд хранит последний
  // терминальный статус вечно, поэтому при заходе на страницу подхватываем
  // только реально идущую синхронизацию — завершённая часы назад не должна
  // встречать админа при каждом визите. Результат, наблюдённый опросом в
  // текущем визите, остаётся видимым до ухода со страницы.
  const loadSyncStatus = useCallback(
    async (adoptFinished = true) => {
      const status = await api.syncToPanelStatus(buildId);
      setSyncStatus(adoptFinished || status.state === "running" ? status : null);
      setSyncing(status.state === "running");
      return status;
    },
    [buildId],
  );

  useEffect(() => {
    // При монтировании — без терминальных статусов с прошлых визитов.
    loadSyncStatus(false).catch(() => undefined);
  }, [loadSyncStatus]);

  // Опрос SFTP-синхронизации: 1 с, только когда идёт running.
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

  const activate = useCallback(async () => {
    if (!detail) return;
    const ok = await confirm({
      title: `Сделать сборку «${detail.name}» активной?`,
      body: `Все игроки при следующем запуске скачают именно её (v${detail.version}, ${detail.files.length} файлов).`,
      confirmText: "Сделать активной",
    });
    if (!ok) return;
    try {
      await api.activateBuild(buildId);
      toast.success("Сборка активирована");
      await onChangedRef.current?.();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось активировать",
      );
    }
  }, [buildId, confirm, detail, toast]);

  const cloneBuild = useCallback(async () => {
    if (!detail || busyClone) return;
    setBusyClone(true);
    try {
      const res = await api.cloneBuild(buildId);
      toast.success(`Создана копия «${detail.name}»`);
      window.dispatchEvent(new Event("builds-updated"));
      onNavigateRef.current(res.id);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось клонировать сборку",
      );
    } finally {
      setBusyClone(false);
    }
  }, [buildId, busyClone, detail, toast]);

  const removeBuild = useCallback(async () => {
    if (!detail || busyDelete) return;
    const ok = await confirm({
      title: `Удалить сборку «${detail.name}»?`,
      body: "Будут удалены все её файлы из манифеста. Действие необратимо.",
      confirmText: "Удалить",
      danger: true,
    });
    if (!ok) return;
    setBusyDelete(true);
    try {
      await api.deleteBuild(buildId);
      toast.success("Сборка удалена");
      window.dispatchEvent(new Event("builds-updated"));
      // Сборки больше нет — уходим к списку.
      onDeletedRef.current?.();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось удалить сборку",
      );
    } finally {
      setBusyDelete(false);
    }
  }, [buildId, busyDelete, confirm, detail, toast]);

  const syncToPanel = useCallback(async () => {
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
  }, [buildId, loadSyncStatus, toast]);

  // Мод всегда попадает в АКТИВНУЮ сборку (так работает бэкенд). Кнопка
  // рендерится только на активной (план 3.2); подсказка со ссылкой на
  // активную — на неактивной. Диалог-компенсатор упразднён.
  const deployMod = useCallback(async () => {
    const ok = await confirm({
      title: "Добавить мод в сборку?",
      body: "Будет скачан последний релиз stardust-mod из GitHub и добавлен в эту сборку. При следующей синхронизации мод попадёт на сервер.",
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
              toast.success(`Мод ${s.version ?? "?"} добавлен в сборку. Синхронизируйте сервер.`);
              await onChangedRef.current?.();
            } else {
              toast.error(`Ошибка деплоя: ${s.error ?? "неизвестная ошибка"}`);
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
        err instanceof ApiError ? err.message : "Не удалось запустить деплой мода",
      );
    }
  }, [confirm, toast]);

  const saveEdit = useCallback(
    async (input: CreateBuildInput) => {
      try {
        await api.updateBuild(buildId, input);
        toast.success("Сборка обновлена");
        await onChangedRef.current?.();
        return true;
      } catch (err) {
        toast.error(
          err instanceof ApiError ? err.message : "Не удалось сохранить",
        );
        return false;
      }
    },
    [buildId, toast],
  );

  const clearCheckResults = useCallback(() => {
    setCheckResults({ build: null, deps: null, loading: false });
  }, []);

  return {
    syncing,
    syncStatus,
    deploying,
    deployStatus,
    checkResults,
    busyClone,
    busyDelete,
    activate,
    cloneBuild,
    removeBuild,
    syncToPanel,
    deployMod,
    runChecks,
    saveEdit,
    loadSyncStatus,
    clearCheckResults,
  };
}

/**
 * Активация сборки из списка/карточки (хаб сборок, оба шелла): тот же
 * confirm и тот же toast, что и в деталях, — без дублирования текстов.
 * Возвращает true, если активация удалась (список можно перезагрузить).
 */
export async function activateBuildFromList(
  buildId: number,
  name: string,
  confirm: ReturnType<typeof useConfirm>,
  toast: ReturnType<typeof useToast>,
  opts: { version?: string; fileCount?: number } = {},
): Promise<boolean> {
  const body = opts.version != null
    ? `Все игроки при следующем запуске скачают именно её (v${opts.version}${opts.fileCount != null ? `, ${opts.fileCount} файлов` : ""}).`
    : "Все игроки при следующем запуске скачают именно её.";
  const ok = await confirm({
    title: `Сделать сборку «${name}» активной?`,
    body,
    confirmText: "Сделать активной",
  });
  if (!ok) return false;
  try {
    await api.activateBuild(buildId);
    toast.success("Сборка активирована");
    return true;
  } catch (err) {
    toast.error(
      err instanceof ApiError ? err.message : "Не удалось активировать",
    );
    return false;
  }
}

// ───────────────────────── EditBuildModal ─────────────────────────

/**
 * Модалка правки параметров сборки. Была продублирована в BuildDetail
 * (~120 строк) и MobileBuildDetail; теперь одна — на общий слой.
 * Dirty-guard на Escape/подложку — общий useDirtyGuard.
 */
export function EditBuildModal({
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
  const dialogRef = useRef<HTMLFormElement>(null);

  const dirty =
    form.name !== initial.name ||
    form.version !== initial.version ||
    form.loaderKind !== initial.loaderKind ||
    form.mcVersion !== initial.mcVersion ||
    form.loaderVersion !== initial.loaderVersion;

  const tryClose = useDirtyGuard({
    isDirty: dirty,
    isBusy: busy,
    onClose,
  });
  useDialogFocus(dialogRef, () => void tryClose());

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
        ref={dialogRef}
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-build-title"
        tabIndex={-1}
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="edit-build-title">Редактировать сборку</h3>
        <div className="row">
          <Field label="Название">
            {(control) => (
              <FieldInput
                control={control}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                autoFocus
                placeholder="Моя сборка"
              />
            )}
          </Field>
          <Field label="Версия сборки">
            {(control) => (
              <FieldInput
                control={control}
                value={form.version}
                onChange={(e) => set("version", e.target.value)}
                placeholder="1.0.0"
              />
            )}
          </Field>
        </div>
        <div className="row">
          <Field label="Загрузчик">
            {(control) => (
              <select
                id={control.id}
                aria-describedby={control.describedBy}
                value={form.loaderKind}
                onChange={(e) => set("loaderKind", e.target.value)}
              >
                {LOADERS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Версия Minecraft">
            {(control) => (
              <FieldInput
                control={control}
                value={form.mcVersion}
                onChange={(e) => set("mcVersion", e.target.value)}
                placeholder="1.21.1"
              />
            )}
          </Field>
          <Field label="Версия загрузчика">
            {(control) => (
              <FieldInput
                control={control}
                value={form.loaderVersion}
                onChange={(e) => set("loaderVersion", e.target.value)}
                placeholder="напр. 21.1.72"
              />
            )}
          </Field>
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

// ───────────────────────── Общие презентационные куски ─────────────────────────

/** Бейдж «активная» в шапке деталей — состояние, не кнопка (план 3.2). */
export function ActiveBuildBadge() {
  return (
    <span className="badge active" title="сборка отдаётся лаунчеру">
      <IconStar size={12} /> активная
    </span>
  );
}
