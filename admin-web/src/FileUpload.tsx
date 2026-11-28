import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { api, ApiError } from "./api";
import type { UploadMeta } from "./types";
import { formatSize, baseName, slugifyModId } from "./format";
import { KINDS, guessKind } from "./fileUtils";
import { useToast, useConfirm } from "./ui/feedback";
import { Field } from "./ui/Field";
import { McText } from "./ui/McText";
import { SidePicker, type ModSide } from "./ui/kit";
import { IconChevronRight, IconFolder, IconUpload } from "./ui/icons";

// Куда по умолчанию кладётся файл в зависимости от типа.
function defaultDir(kind: string): string {
  switch (kind) {
    case "mod":
      return "mods/";
    case "config":
      return "config/";
    case "resource":
      return "resourcepacks/";
    default:
      return "";
  }
}

// Каталог, куда складывать загружаемый файл: если выбрана целевая папка —
// кладём туда, иначе подбираем по типу.
function targetDirFor(kind: string, dir: string): string {
  if (dir) return dir.replace(/\/+$/, "") + "/";
  return defaultDir(kind);
}

/**
 * Путь в .minecraft для очереди. Файл из папки (webkitdirectory/drag-drop
 * каталога) сохраняет структуру подпапок как есть — целевая папка становится
 * префиксом. Одиночный файл в корень подбирает папку по типу.
 */
function computePath(rel: string, kind: string, dir: string): string {
  const name = baseName(rel);
  if (rel.includes("/")) {
    // Файл из папки уже несёт свой каталог (mods/foo.jar) — поверх
    // подставляем только явно выбранную целевую папку, без defaultDir:
    // иначе дроп папки в корень дублирует каталог (mods/mods/foo.jar).
    const prefix = dir ? dir.replace(/\/+$/, "") + "/" : "";
    return prefix + rel;
  }
  return targetDirFor(kind, dir) + name;
}

type Status = "queued" | "uploading" | "done" | "error";

interface QueueItem {
  id: number;
  file: File;
  kind: string;
  side: string;
  /** Относительный путь (для папок — со структурой подпапок). */
  rel: string;
  path: string;
  /** Путь проставлен автоматически и следует за целевой папкой. */
  autoPath: boolean;
  overwrite: boolean;
  optional: boolean;
  enabledByDefault: boolean;
  modId: string;
  displayName: string;
  description: string;
  /** Профили модов, в которые попадает файл (ключи). */
  profiles: string[];
  status: Status;
  progress: number;
  error?: string;
}

let nextItemId = 1;

// Имя файла с учётом относительного пути при загрузке папки.
// Браузер кладёт путь в `webkitRelativePath` (напр. `mods/sub/a.jar`).
function relPath(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string })
    .webkitRelativePath;
  return rel && rel.length > 0 ? rel : file.name;
}

function makeItem(file: File, dir: string): QueueItem {
  const rel = relPath(file);
  const kind = guessKind(file.name);
  // Структуру папки сохраняем как есть под целевым каталогом. Дефолтный
  // каталог по типу НЕ подставляем поверх: иначе путь дублируется
  // (напр. перетащили папку `config` в корень → `config/config/…`).
  return {
    id: nextItemId++,
    file,
    kind,
    side: "both",
    rel,
    path: computePath(rel, kind, dir),
    autoPath: true,
    overwrite: true,
    optional: false,
    enabledByDefault: true,
    modId: "",
    displayName: "",
    description: "",
    profiles: [],
    status: "queued",
    progress: 0,
  };
}

export interface FileUploadHandle {
  // Принимает содержимое drop'а из любого места файлового менеджера.
  addFromDataTransfer: (dt: DataTransfer) => void;
  // Прокручивает страницу к очереди загрузки (после дропа на менеджер).
  scrollIntoQueue: () => void;
}

export const FileUpload = forwardRef<
  FileUploadHandle,
  {
    buildId: number;
    onUploaded: () => void;
    modProfiles?: { key: string; name: string; description: string | null }[];
    /** Пути файлов, уже существующих в сборке — для предупреждения
     *  о перезаписи (повторная загрузка по тому же пути сбрасывает
     *  все свойства файла на сервере, включая optional/modId/профили). */
    existingPaths?: string[];
  }
>(function FileUpload(
  { buildId, onUploaded, modProfiles = [], existingPaths = [] },
  ref,
) {
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  // Целевая папка загрузки: дерево существующих папок + ввод новой.
  // Пустая строка — корень .minecraft.
  const [targetDir, setTargetDir] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const stopRequested = useRef(false);

  // Существующие пути сборки в нижнем регистре: сравнение путей при
  // обнаружении перезаписи — регистронезависимое.
  const existingSet = useMemo(
    () => new Set(existingPaths.map((p) => p.trim().toLowerCase())),
    [existingPaths],
  );

  // Существующие папки сборки (с перечнем прямых файлов) — для дерева выбора
  // целевой папки.
  const folders = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of existingPaths) {
      const parts = p.trim().split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        map.set(dir, (map.get(dir) ?? 0) + 1);
      }
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([path, count]) => ({ path, count }));
  }, [existingPaths]);

  // Повторная загрузка по существующему пути сбрасывает все свойства файла
  // на сервере (optional, modId, профили, отображаемое имя) — такие строки
  // очереди помечаем предупреждением. Готовые/загружаемые строки не считаем:
  // для них «перезапишет» уже не будущее действие.
  function overwritesExisting(path: string): boolean {
    return existingSet.has(path.trim().toLowerCase());
  }

  function warnsOverwrite(it: { path: string; status: Status }): boolean {
    return (
      (it.status === "queued" || it.status === "error") &&
      overwritesExisting(it.path)
    );
  }

  function addFiles(files: FileList | File[]) {
    const arr = Array.from(files).map((f) => makeItem(f, targetDir));
    if (arr.length) {
      setItems((cur) => [...cur, ...arr]);
      // Дроп на менеджер далеко от очереди: подтверждаем, что файлы приняты.
      toast.info(`Добавлено в очередь: ${arr.length}`);
    }
  }

  // Смена целевой папки перестраивает автопути очереди (пользовательские
  // правки пути не трогаем); уже загружаемые/готовые строки не трогаем.
  function changeTargetDir(dir: string) {
    setTargetDir(dir);
    setItems((cur) =>
      cur.map((it) =>
        it.autoPath && it.status !== "done" && it.status !== "uploading"
          ? { ...it, path: computePath(it.rel, it.kind, dir) }
          : it,
      ),
    );
  }

  // Рекурсивный обход перетащенной папки через webkitGetAsEntry: собираем
  // файлы с относительными путями, чтобы сохранить структуру каталогов.
  async function collectEntry(
    entry: FileSystemEntry,
    prefix: string,
    out: File[],
  ): Promise<void> {
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      const file = await new Promise<File>((resolve, reject) =>
        fileEntry.file(resolve, reject),
      );
      // Пробрасываем относительный путь, как это делает webkitdirectory.
      Object.defineProperty(file, "webkitRelativePath", {
        value: prefix + file.name,
      });
      out.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries отдаёт максимум 100 записей за вызов: читаем циклом,
      // пока не придёт пустой массив, иначе большие папки теряют хвост.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (batch.length === 0) break;
        for (const child of batch) {
          await collectEntry(child, prefix + entry.name + "/", out);
        }
      }
    }
  }

  function patch(id: number, p: Partial<QueueItem>) {
    setItems((cur) => cur.map((it) => (it.id === id ? { ...it, ...p } : it)));
  }

  /** Применить метаданные ко всем ещё не загруженным файлам очереди. */
  function applyToAll(p: Partial<QueueItem>) {
    setItems((cur) =>
      cur.map((it) => (it.status === "queued" || it.status === "error" ? { ...it, ...p } : it)),
    );
  }

  /** Переключить профиль у всех незагруженных (для чипов). */
  function toggleProfileAll(key: string) {
    setItems((cur) =>
      cur.map((it) => {
        if (it.status === "done" || it.status === "uploading") return it;
        const has = it.profiles.includes(key);
        return { ...it, profiles: has ? it.profiles.filter((k) => k !== key) : [...it.profiles, key] };
      }),
    );
  }

  function remove(id: number) {
    setItems((cur) => cur.filter((it) => it.id !== id));
  }

  // Разбирает содержимое drop'а: рекурсивно обходит папки (если браузер даёт
  // файловые entry), иначе берёт плоский список файлов.
  function addFromDataTransfer(dt: DataTransfer) {
    const dtItems = dt.items;
    const entries: FileSystemEntry[] = [];
    for (let i = 0; i < dtItems.length; i++) {
      const entry = dtItems[i].webkitGetAsEntry?.();
      if (entry) entries.push(entry);
    }
    if (entries.length) {
      (async () => {
        const out: File[] = [];
        for (const entry of entries) await collectEntry(entry, "", out);
        addFiles(out);
      })();
    } else if (dt.files.length) {
      addFiles(dt.files);
    }
  }

  useImperativeHandle(ref, () => ({
    addFromDataTransfer,
    scrollIntoQueue: () => rootRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
  }));

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    addFromDataTransfer(e.dataTransfer);
  }

  async function uploadAll(onlyErrors = false) {
    stopRequested.current = false;
    setBusy(true);
    let ok = 0;
    let failed = 0;
    let skipped = 0;
    const queue = onlyErrors ? items.filter((it) => it.status === "error") : items;
    // Грузим последовательно: меньше нагрузка и предсказуемый прогресс.
    for (const it of queue) {
      if (stopRequested.current) {
        skipped++;
        continue;
      }
      if (it.status === "done") continue;
      if (!it.path.trim()) {
        patch(it.id, { status: "error", error: "Пустой путь" });
        failed++;
        continue;
      }
      patch(it.id, { status: "uploading", progress: 0, error: undefined });
      const meta: UploadMeta = {
        path: it.path.trim(),
        kind: it.kind,
        side: it.side,
        overwrite: it.overwrite,
        optional: it.optional,
        enabledByDefault: it.enabledByDefault,
        modId: it.optional && it.modId.trim() ? it.modId.trim() : undefined,
        displayName: it.displayName.trim() || undefined,
        description: it.description.trim() || undefined,
        profiles: it.profiles,
      };
      try {
        await api.uploadFileProgress(buildId, it.file, meta, (frac) =>
          patch(it.id, { progress: frac }),
        );
        patch(it.id, { status: "done", progress: 1 });
        ok++;
      } catch (err) {
        patch(it.id, {
          status: "error",
          error: err instanceof ApiError ? err.message : "Ошибка загрузки",
        });
        failed++;
      }
    }
    setBusy(false);
    if (ok) {
      toast.success(`Загружено файлов: ${ok}`);
      setItems((cur) => cur.filter((it) => it.status !== "done"));
      onUploaded();
    }
    if (failed) toast.error(`Не удалось загрузить: ${failed}`);
    if (skipped) toast.info(`Остановлено, осталось в очереди: ${skipped}`);
  }

  const queuedCount = items.filter((it) => it.status === "queued").length;
  const uploadingCount = items.filter((it) => it.status === "uploading").length;
  const doneCount = items.filter((it) => it.status === "done").length;
  const errorCount = items.filter((it) => it.status === "error").length;
  const pending = items.filter((it) => it.status !== "done").length;
  // Сколько строк очереди лягут поверх уже существующих путей сборки.
  const overwriteCount = items.filter(warnsOverwrite).length;

  // Предпросмотр изменений манифеста: очередь против сохранённого состояния
  // сборки. Добавленные и перезаписываемые файлы с путями и размерами —
  // до нажатия «Загрузить» видно, что попадёт в манифест.
  const manifestDiff = useMemo(() => {
    const pendingItems = items.filter(
      (it) => it.status === "queued" || it.status === "error",
    );
    const added = pendingItems.filter((it) => !overwritesExisting(it.path));
    const changed = pendingItems.filter((it) => overwritesExisting(it.path));
    return {
      added,
      changed,
      addedSize: added.reduce((s, it) => s + it.file.size, 0),
      changedSize: changed.reduce((s, it) => s + it.file.size, 0),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, existingSet]);

  const target = targetDir
    ? `.minecraft/${targetDir.replace(/\/+$/, "")}/`
    : ".minecraft/";

  return (
    <div className="fm-upload" ref={rootRef}>
      <h2>
        Загрузка файлов
        <span className="fm-upload-target muted"> → {target}</span>
      </h2>

      <TargetFolderPicker
        targetDir={targetDir}
        folders={folders}
        disabled={busy}
        onChange={changeTargetDir}
      />

      <div
        className={`dropzone${dragging ? " over" : ""}`}
        role="button"
        tabIndex={0}
        aria-label="Загрузить файлы: перетащите или выберите на диске"
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <IconUpload size={28} />
        <p>
          Перетащите файлы сюда или <span className="link">выберите файлы</span>
          {" • "}
          {/* Настоящая кнопка (а не span с onClick): до неё можно добраться
              с клавиатуры. Keydown не всплывает к дропзоне, иначе её
              обработчик Enter/Space открыл бы диалог выбора файлов. */}
          <button
            type="button"
            className="link"
            onClick={(e) => {
              e.stopPropagation();
              dirInputRef.current?.click();
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            загрузить папку
          </button>
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={dirInputRef}
          type="file"
          hidden
          // @ts-expect-error — нестандартные атрибуты выбора каталога.
          webkitdirectory=""
          directory=""
          multiple
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {items.length > 0 && (
        <>
          <div className="queue-summary" aria-live="polite">
            <span>В очереди: {queuedCount}</span>
            {uploadingCount > 0 && <span>загружается: {uploadingCount}</span>}
            {doneCount > 0 && <span>готово: {doneCount}</span>}
            {errorCount > 0 && <span className="queue-summary-error">ошибки: {errorCount}</span>}
            {overwriteCount > 0 && (
              <span className="queue-summary-warn">
                перезапишут: {overwriteCount}
              </span>
            )}
          </div>

          {/* Предпросмотр diff манифеста до применения: что появится (+)
              и что перезапишется (~) с путями и размерами. */}
          {(manifestDiff.added.length > 0 || manifestDiff.changed.length > 0) && (
            <details className="fm-diff fm-diff--upload">
              <summary>
                Изменения манифеста:{" "}
                <span className="fm-diff-add">+{manifestDiff.added.length} новых</span>
                {manifestDiff.added.length > 0 && (
                  <span className="muted"> ({formatSize(manifestDiff.addedSize)})</span>
                )}
                {manifestDiff.changed.length > 0 && (
                  <>
                    {" · "}
                    <span className="fm-diff-chg">~{manifestDiff.changed.length} перезаписей</span>
                    <span className="muted"> ({formatSize(manifestDiff.changedSize)})</span>
                  </>
                )}
              </summary>
              <ul className="fm-diff-list">
                {[...manifestDiff.added, ...manifestDiff.changed].slice(0, 100).map((it) => {
                  const over = overwritesExisting(it.path);
                  return (
                    <li key={it.id} className={over ? "fm-diff-chg" : "fm-diff-add"}>
                      <span className="fm-diff-sign">{over ? "~" : "+"}</span>
                      <span className="fm-diff-path" title={it.path}>{it.path}</span>
                      <span className="muted">{formatSize(it.file.size)}</span>
                    </li>
                  );
                })}
                {manifestDiff.added.length + manifestDiff.changed.length > 100 && (
                  <li className="muted">…и ещё {manifestDiff.added.length + manifestDiff.changed.length - 100}</li>
                )}
              </ul>
            </details>
          )}

          {/* Быстрая настройка всей очереди: тип/сторона/опциональность
              и профили — вместо поштучного «настроить» у 30 файлов. */}
          <details className="queue-batch">
            <summary>Применить ко всем ({pending})</summary>
            <div className="queue-batch-body">
              <div className="row">
                <div className="field">
                  <label>Тип</label>
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) applyToAll({ kind: e.target.value });
                      e.target.value = "";
                    }}
                  >
                    <option value="">— выбрать —</option>
                    {KINDS.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Сторона</label>
                  {/* SidePicker с «Все» = «не менять» (значение-заглушка). */}
                  <SidePicker<ModSide | "all">
                    value="all"
                    allowAll
                    disabled={busy}
                    onChange={(side) => {
                      if (side !== "all") applyToAll({ side });
                    }}
                  />
                </div>
              </div>
              <div className="row">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    onChange={(e) => applyToAll({ optional: e.target.checked })}
                  />
                  Опциональные
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    onChange={(e) => applyToAll({ overwrite: e.target.checked })}
                  />
                  Перезаписывать
                </label>
              </div>
              {modProfiles.length > 0 && (
                <div className="field">
                  <label>Профили модов</label>
                  <div className="fm-profile-chips">
                    {modProfiles.map((p) => {
                      // [] .every(...) === true — без проверки длины чипы
                      // выглядели бы «включёнными», когда ставить нечего.
                      const pending = items.filter(
                        (it) => it.status === "queued" || it.status === "error",
                      );
                      const on =
                        pending.length > 0 &&
                        pending.every((it) => it.profiles.includes(p.key));
                      return (
                        <button
                          key={p.key}
                          type="button"
                          className={`fm-profile-chip${on ? " on" : ""}`}
                          disabled={busy}
                          aria-pressed={on}
                          title={p.description ?? undefined}
                          onClick={() => toggleProfileAll(p.key)}
                        >
                          {/* Имя профиля — контент админа: эмодзи глифами. */}
                          <McText text={p.name} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </details>

          <div className="queue">
            {items.map((it) => (
              <QueueRow
                key={it.id}
                item={it}
                disabled={busy}
                targetDir={targetDir}
                modProfiles={modProfiles}
                overwrite={warnsOverwrite(it)}
                onPatch={(p) => patch(it.id, p)}
                onRemove={() => remove(it.id)}
              />
            ))}
          </div>
          <div className="queue-actions">
            <button
              type="button"
              onClick={async () => {
                // Настройки строк очереди не выбрасываем молча: ask через
                // styled useConfirm (в iOS standalone-PWA window.confirm
                // не отображается — план 3.8/4.1).
                const dirty = items.some(
                  (it) => it.status !== "done" && (it.optional || it.modId.trim() || it.displayName.trim() || it.profiles.length > 0),
                );
                if (
                  dirty &&
                  !(await confirm({
                    title: "Очистить очередь?",
                    body: "Убрать все файлы очереди вместе с введёнными настройками?",
                    confirmText: "Очистить",
                    danger: true,
                  }))
                ) return;
                setItems([]);
              }}
              disabled={busy}
            >
              Очистить
            </button>
            {doneCount > 0 && (
              <button
                type="button"
                onClick={() => setItems((cur) => cur.filter((it) => it.status !== "done"))}
                disabled={busy}
              >
                Убрать готовые
              </button>
            )}
            {errorCount > 0 && (
              <button
                type="button"
                onClick={() => uploadAll(true)}
                disabled={busy}
              >
                Повторить ошибки ({errorCount})
              </button>
            )}
            {busy ? (
              <button type="button" onClick={() => (stopRequested.current = true)}>
                Остановить после текущего
              </button>
            ) : (
              <button
                className="primary"
                onClick={() => uploadAll()}
                disabled={pending === 0}
              >
                Загрузить ({pending})
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
});

// Выбор целевой папки загрузки: дерево существующих папок сборки (раскрывается)
// с выбором радиокнопкой + ввод пути новой папки.
function TargetFolderPicker({
  targetDir,
  folders,
  disabled,
  onChange,
}: {
  targetDir: string;
  folders: { path: string; count: number }[];
  disabled: boolean;
  onChange: (dir: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [newDir, setNewDir] = useState("");

  const label = targetDir
    ? `.minecraft/${targetDir.replace(/\/+$/, "")}/`
    : ".minecraft/ (корень)";

  function pickNew() {
    const clean = newDir.trim().replace(/^\/+|\/+$/g, "");
    if (!clean) return;
    onChange(clean);
    setNewDir("");
    setOpen(false);
  }

  return (
    <div className="fm-target-picker">
      <button
        type="button"
        className="fm-target-btn"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <IconFolder size={15} className="folder" />
        Папка назначения: <strong>{label}</strong>
        <IconChevronRight size={14} className={`fm-target-chevron${open ? " open" : ""}`} />
      </button>
      {open && (
        <div className="fm-target-panel">
          <label className="fm-target-row">
            <input
              type="radio"
              name="fm-target-dir"
              checked={targetDir === ""}
              onChange={() => {
                onChange("");
                setOpen(false);
              }}
            />
            <span>.minecraft — корень</span>
          </label>
          {folders.map((f) => (
            <label key={f.path} className="fm-target-row">
              <input
                type="radio"
                name="fm-target-dir"
                checked={targetDir === f.path}
                onChange={() => {
                  onChange(f.path);
                  setOpen(false);
                }}
              />
              <span className="fm-target-path" title={f.path}>{f.path}/</span>
              <span className="muted">{f.count}</span>
            </label>
          ))}
          <div className="fm-target-new">
            <input
              value={newDir}
              placeholder="новая папка, напр. shaders"
              disabled={disabled}
              onChange={(e) => setNewDir(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  pickNew();
                }
              }}
            />
            <button
              type="button"
              className="secondary"
              disabled={disabled || !newDir.trim()}
              onClick={pickNew}
            >
              Выбрать
            </button>
          </div>
          <p className="muted fm-target-hint">
            Загрузка папки сохраняет структуру подпапок внутри выбранной папки.
          </p>
        </div>
      )}
    </div>
  );
}

function QueueRow({
  item,
  disabled,
  targetDir,
  modProfiles,
  overwrite,
  onPatch,
  onRemove,
}: {
  item: QueueItem;
  disabled: boolean;
  /** Текущая целевая папка очереди — автопуть следует за ней и за типом. */
  targetDir: string;
  modProfiles: { key: string; name: string; description: string | null }[];
  overwrite: boolean;
  onPatch: (p: Partial<QueueItem>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);

  function changeKind(kind: string) {
    // Автопуть следует за типом (в корне файл подбирает папку по типу);
    // правленый вручную путь не трогаем.
    const patch: Partial<QueueItem> = { kind };
    if (item.autoPath) patch.path = computePath(item.rel, kind, targetDir);
    onPatch(patch);
  }

  return (
    <div className={`q-item status-${item.status}`}>
      <div className="q-head">
        <div className="q-name">
          <strong>{item.file.name}</strong>
          <span className="muted">{formatSize(item.file.size)}</span>
          {overwrite && (
            <span
              className="tag tag--yellow q-overwrite"
              title="Файл по этому пути уже есть в сборке: после загрузки его свойства (опциональность, mod id, профили, имя) сбросятся на значения из этой строки"
            >
              перезапишет существующий
            </span>
          )}
        </div>
        <div className="q-right">
          {item.status === "error" && (
            <span className="q-err" title={item.error}>
              {item.error}
            </span>
          )}
          {item.status === "done" && <span className="q-ok">готово</span>}
          <button
            type="button"
            className="link-btn"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            disabled={disabled}
          >
            {open ? "скрыть" : "настроить"}
          </button>
          <button
            type="button"
            className="danger icon-only"
            aria-label="Убрать из очереди"
            title="Убрать из очереди"
            onClick={onRemove}
            disabled={disabled}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Путь и тип видны всегда — это главные метаданные строки,
          не стоит прятать их за «настроить». */}
      <div className="q-path">
        <span className={`tag kind-${item.kind}`}>{item.kind}</span>
        <span className="q-path-target" title={item.path}>
          {item.path}
        </span>
      </div>

      {(item.status === "uploading" || item.status === "done") && (
        <div className="progress">
          <div
            className="progress-bar"
            style={{ width: `${Math.round(item.progress * 100)}%` }}
          />
        </div>
      )}

      {open && (
        <div className="q-body">
          <div className="row">
            <Field label="Тип">
              {(control) => (
                <select
                  id={control.id}
                  aria-describedby={control.describedBy}
                  value={item.kind}
                  onChange={(e) => changeKind(e.target.value)}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Сторона">
              {(control) => (
                <div
                  id={control.id}
                  aria-describedby={control.describedBy}
                >
                  <SidePicker<ModSide>
                    value={item.side as ModSide}
                    disabled={disabled}
                    onChange={(side) => onPatch({ side })}
                  />
                </div>
              )}
            </Field>
          </div>
          <Field label="Путь в .minecraft">
            {(control) => (
              <input
                id={control.id}
                aria-describedby={control.describedBy}
                value={item.path}
                onChange={(e) => onPatch({ path: e.target.value, autoPath: false })}
                placeholder="mods/sodium.jar"
              />
            )}
          </Field>
          <div className="row">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={item.overwrite}
                onChange={(e) => onPatch({ overwrite: e.target.checked })}
              />
              Перезаписывать
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={item.optional}
                onChange={(e) => {
                  const optional = e.target.checked;
                  // При включении опциональности подставляем modId из имени
                  // файла, если поле ещё пустое — чтобы не заполнять вручную.
                  const patch: Partial<QueueItem> = { optional };
                  if (optional && !item.modId.trim()) {
                    patch.modId = slugifyModId(item.path || item.file.name);
                  }
                  onPatch(patch);
                }}
              />
              Опциональный
            </label>
            {item.optional && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={item.enabledByDefault}
                  onChange={(e) =>
                    onPatch({ enabledByDefault: e.target.checked })
                  }
                />
                Включён по умолчанию
              </label>
            )}
          </div>
          <div className="row">
            <Field label="Отображаемое имя">
              {(control) => (
                <input
                  id={control.id}
                  aria-describedby={control.describedBy}
                  value={item.displayName}
                  onChange={(e) => onPatch({ displayName: e.target.value })}
                  placeholder="напр. Sodium"
                />
              )}
            </Field>
            {item.optional && (
              <Field
                label="mod id (для запоминания выбора игрока)"
                hint="Обычно modid или slug; по нему лаунчер запоминает выбор игрока."
              >
                {(control) => (
                  <input
                    id={control.id}
                    aria-describedby={control.describedBy}
                    value={item.modId}
                    onChange={(e) => onPatch({ modId: e.target.value })}
                  />
                )}
              </Field>
            )}
          </div>
          {modProfiles.length > 0 && (
            <Field label="Профили модов">
              {(control) => (
                <div
                  id={control.id}
                  className="fm-profile-chips"
                  aria-describedby={control.describedBy}
                >
                  {modProfiles.map((p) => {
                    const on = item.profiles.includes(p.key);
                    return (
                      <button
                        key={p.key}
                        type="button"
                        className={`fm-profile-chip${on ? " on" : ""}`}
                        disabled={disabled}
                        aria-pressed={on}
                        title={p.description ?? undefined}
                        onClick={() =>
                          onPatch({
                            profiles: on
                              ? item.profiles.filter((k) => k !== p.key)
                              : [...item.profiles, p.key],
                          })
                        }
                      >
                        <McText text={p.name} />
                      </button>
                    );
                  })}
                </div>
              )}
            </Field>
          )}
          <Field label="Описание">
            {(control) => (
              <input
                id={control.id}
                aria-describedby={control.describedBy}
                value={item.description}
                onChange={(e) => onPatch({ description: e.target.value })}
                placeholder="Короткое описание (необязательно)"
              />
            )}
          </Field>
        </div>
      )}
    </div>
  );
}
