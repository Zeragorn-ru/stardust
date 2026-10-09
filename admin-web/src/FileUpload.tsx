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
import { KINDS, SIDES, guessKind } from "./fileUtils";
import { useToast } from "./ui/feedback";
import { IconUpload } from "./ui/icons";

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

// Каталог, куда складывать загружаемый файл: если открыта папка в файловом
// менеджере — кладём туда, иначе подбираем по типу.
function targetDir(kind: string, baseDir: string): string {
  if (baseDir) return baseDir.replace(/\/+$/, "") + "/";
  return defaultDir(kind);
}

type Status = "queued" | "uploading" | "done" | "error";

interface QueueItem {
  id: number;
  file: File;
  kind: string;
  side: string;
  path: string;
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

function makeItem(file: File, baseDir: string): QueueItem {
  const rel = relPath(file);
  const kind = guessKind(file.name);
  // Если это файл из папки — сохраняем её структуру как есть под текущим
  // каталогом. Дефолтный каталог по типу НЕ подставляем: иначе путь
  // дублируется (напр. перетащили папку `config` в корень → `config/config/…`).
  const hasDir = rel.includes("/");
  const prefix = baseDir ? baseDir.replace(/\/+$/, "") + "/" : "";
  const path = hasDir ? prefix + rel : targetDir(kind, baseDir) + file.name;
  return {
    id: nextItemId++,
    file,
    kind,
    side: "both",
    path,
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
    baseDir?: string;
    modProfiles?: { key: string; name: string; description: string | null }[];
    /** Пути файлов, уже существующих в сборке — для предупреждения
     *  о перезаписи (повторная загрузка по тому же пути сбрасывает
     *  все свойства файла на сервере, включая optional/modId/профили). */
    existingPaths?: string[];
  }
>(function FileUpload(
  { buildId, onUploaded, baseDir = "", modProfiles = [], existingPaths = [] },
  ref,
) {
  const toast = useToast();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
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
    const arr = Array.from(files).map((f) => makeItem(f, baseDir));
    if (arr.length) {
      setItems((cur) => [...cur, ...arr]);
      // Дроп на менеджер далеко от очереди: подтверждаем, что файлы приняты.
      toast.info(`Добавлено в очередь: ${arr.length}`);
    }
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
  const target = baseDir ? `.minecraft/${baseDir.replace(/\/+$/, "")}/` : "";

  return (
    <div className="fm-upload" ref={rootRef}>
      <h2>
        Загрузка файлов
        {target && <span className="fm-upload-target muted"> → {target}</span>}
      </h2>

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
                  <select
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value) applyToAll({ side: e.target.value });
                      e.target.value = "";
                    }}
                  >
                    <option value="">— выбрать —</option>
                    {SIDES.map((sd) => (
                      <option key={sd} value={sd}>{sd}</option>
                    ))}
                  </select>
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
                          {p.name}
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
                baseDir={baseDir}
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
              onClick={() => {
                const dirty = items.some(
                  (it) => it.status !== "done" && (it.optional || it.modId.trim() || it.displayName.trim() || it.profiles.length > 0),
                );
                if (dirty && !window.confirm("Убрать все файлы очереди вместе с введёнными настройками?")) return;
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

function QueueRow({
  item,
  disabled,
  baseDir,
  modProfiles,
  overwrite,
  onPatch,
  onRemove,
}: {
  item: QueueItem;
  disabled: boolean;
  baseDir: string;
  modProfiles: { key: string; name: string; description: string | null }[];
  /** Файл ляжет поверх существующего пути сборки. */
  overwrite: boolean;
  onPatch: (p: Partial<QueueItem>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);

  function changeKind(kind: string) {
    // Подстраиваем путь под новый тип, если пользователь его не правил вручную.
    // Когда открыта папка, путь к ней не трогаем — меняем только тип.
    const auto = targetDir(item.kind, baseDir) + baseName(item.path);
    const patch: Partial<QueueItem> = { kind };
    if (!baseDir && item.path === auto) {
      patch.path = targetDir(kind, baseDir) + baseName(item.path);
    }
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
            <div className="field">
              <label>Тип</label>
              <select
                value={item.kind}
                onChange={(e) => changeKind(e.target.value)}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Сторона</label>
              <select
                value={item.side}
                onChange={(e) => onPatch({ side: e.target.value })}
              >
                {SIDES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label>Путь в .minecraft</label>
            <input
              value={item.path}
              onChange={(e) => onPatch({ path: e.target.value })}
              placeholder="mods/sodium.jar"
            />
          </div>
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
            <div className="field">
              <label>Отображаемое имя</label>
              <input
                value={item.displayName}
                onChange={(e) => onPatch({ displayName: e.target.value })}
                placeholder="напр. Sodium"
              />
            </div>
            {item.optional && (
              <div className="field">
                <label>mod id (для запоминания выбора игрока)</label>
                <input
                  value={item.modId}
                  onChange={(e) => onPatch({ modId: e.target.value })}
                />
              </div>
            )}
          </div>
          {modProfiles.length > 0 && (
            <div className="field">
              <label>Профили модов</label>
              <div className="fm-profile-chips">
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
                      {p.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="field">
            <label>Описание</label>
            <input
              value={item.description}
              onChange={(e) => onPatch({ description: e.target.value })}
              placeholder="Короткое описание (необязательно)"
            />
          </div>
        </div>
      )}
    </div>
  );
}
