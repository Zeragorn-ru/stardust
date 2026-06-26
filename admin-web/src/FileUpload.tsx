import { useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { UploadMeta } from "./types";
import { formatSize, baseName } from "./format";
import { useToast } from "./ui/feedback";
import { IconUpload } from "./ui/icons";

const KINDS = ["mod", "config", "resource", "other"];
const SIDES = ["both", "client", "server"];

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

// Угадываем тип по расширению/имени файла.
function guessKind(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".jar")) return "mod";
  if (n.endsWith(".zip")) return "resource";
  if (n.endsWith(".toml") || n.endsWith(".json") || n.endsWith(".cfg"))
    return "config";
  return "other";
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
  status: Status;
  progress: number;
  error?: string;
}

let nextItemId = 1;

function makeItem(file: File): QueueItem {
  const kind = guessKind(file.name);
  return {
    id: nextItemId++,
    file,
    kind,
    side: "both",
    path: defaultDir(kind) + file.name,
    overwrite: true,
    optional: false,
    enabledByDefault: true,
    modId: "",
    displayName: "",
    status: "queued",
    progress: 0,
  };
}

export function FileUpload({
  buildId,
  onUploaded,
}: {
  buildId: number;
  onUploaded: () => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function addFiles(files: FileList | File[]) {
    const arr = Array.from(files).map(makeItem);
    if (arr.length) setItems((cur) => [...cur, ...arr]);
  }

  function patch(id: number, p: Partial<QueueItem>) {
    setItems((cur) => cur.map((it) => (it.id === id ? { ...it, ...p } : it)));
  }

  function remove(id: number) {
    setItems((cur) => cur.filter((it) => it.id !== id));
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  }

  async function uploadAll() {
    setBusy(true);
    let ok = 0;
    let failed = 0;
    // Грузим последовательно: меньше нагрузка и предсказуемый прогресс.
    for (const it of items) {
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
      // Убираем успешно загруженные из очереди.
      setItems((cur) => cur.filter((it) => it.status !== "done"));
      onUploaded();
    }
    if (failed) toast.error(`Не удалось загрузить: ${failed}`);
  }

  const pending = items.filter((it) => it.status !== "done").length;

  return (
    <div className="panel">
      <h2>Загрузка файлов</h2>

      <div
        className={`dropzone${dragging ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
      >
        <IconUpload size={28} />
        <p>
          Перетащите файлы сюда или <span className="link">выберите</span>
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
      </div>

      {items.length > 0 && (
        <>
          <div className="queue">
            {items.map((it) => (
              <QueueRow
                key={it.id}
                item={it}
                disabled={busy}
                onPatch={(p) => patch(it.id, p)}
                onRemove={() => remove(it.id)}
              />
            ))}
          </div>
          <div className="queue-actions">
            <button type="button" onClick={() => setItems([])} disabled={busy}>
              Очистить
            </button>
            <button
              className="primary"
              onClick={uploadAll}
              disabled={busy || pending === 0}
            >
              {busy ? "Загрузка…" : `Загрузить (${pending})`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function QueueRow({
  item,
  disabled,
  onPatch,
  onRemove,
}: {
  item: QueueItem;
  disabled: boolean;
  onPatch: (p: Partial<QueueItem>) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);

  function changeKind(kind: string) {
    // Подстраиваем путь под новый тип, если пользователь его не правил вручную.
    const auto = defaultDir(item.kind) + baseName(item.path);
    const patch: Partial<QueueItem> = { kind };
    if (item.path === auto) patch.path = defaultDir(kind) + baseName(item.path);
    onPatch(patch);
  }

  return (
    <div className={`q-item status-${item.status}`}>
      <div className="q-head">
        <div className="q-name">
          <strong>{item.file.name}</strong>
          <span className="muted">{formatSize(item.file.size)}</span>
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
            onClick={() => setOpen((v) => !v)}
            disabled={disabled}
          >
            {open ? "скрыть" : "настроить"}
          </button>
          <button
            type="button"
            className="danger icon-only"
            onClick={onRemove}
            disabled={disabled}
          >
            ✕
          </button>
        </div>
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
                onChange={(e) => onPatch({ optional: e.target.checked })}
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
          {item.optional && (
            <div className="row">
              <div className="field">
                <label>mod id (для запоминания выбора игрока)</label>
                <input
                  value={item.modId}
                  onChange={(e) => onPatch({ modId: e.target.value })}
                />
              </div>
              <div className="field">
                <label>Отображаемое имя</label>
                <input
                  value={item.displayName}
                  onChange={(e) => onPatch({ displayName: e.target.value })}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
