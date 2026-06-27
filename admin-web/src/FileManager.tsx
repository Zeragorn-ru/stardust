// Файловый менеджер сборки в стиле панелей вроде Pterodactyl.
//
// Сервер хранит файлы плоским списком с полным путём относительно `.minecraft`
// (напр. `config/foo/bar.toml`). Дерево каталогов мы строим на лету из этих
// путей: навигация по папкам, хлебные крошки, скачивание и удаление.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { BuildFile } from "./types";
import { FileUpload } from "./FileUpload";
import { FileEditor, isEditable } from "./FileEditor";
import {
  baseName,
  formatSize,
  normalizeDir,
  parentDir,
  shortSha,
  slugifyModId,
} from "./format";
import { useConfirm, useToast } from "./ui/feedback";
import { useBodyScrollLock } from "./ui/useBodyScrollLock";
import {
  IconChevronRight,
  IconClose,
  IconCornerUp,
  IconDownload,
  IconFile,
  IconFolder,
  IconHome,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
} from "./ui/icons";

import { KINDS, SIDES, guessKind } from "./fileUtils";

function sideLabel(s: string): string {
  return s === "both" ? "обе" : s === "client" ? "клиент" : "сервер";
}

// Подпапка текущего каталога с агрегатами по содержимому.
interface FolderEntry {
  name: string;
  path: string; // полный путь каталога относительно .minecraft
  fileCount: number;
  totalSize: number;
}

interface Listing {
  folders: FolderEntry[];
  files: BuildFile[];
}

// Строит листинг одного каталога `dir` из плоского списка файлов.
function buildListing(files: BuildFile[], dir: string): Listing {
  const prefix = dir ? dir + "/" : "";
  const folders = new Map<string, FolderEntry>();
  const here: BuildFile[] = [];

  for (const f of files) {
    if (prefix && !f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      here.push(f);
    } else {
      const name = rest.slice(0, slash);
      const full = prefix + name;
      const entry = folders.get(name) ?? {
        name,
        path: full,
        fileCount: 0,
        totalSize: 0,
      };
      entry.fileCount += 1;
      entry.totalSize += f.sizeBytes;
      folders.set(name, entry);
    }
  }

  return {
    folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)),
    files: here.sort((a, b) =>
      baseName(a.path).localeCompare(baseName(b.path)),
    ),
  };
}

const KIND_FILTERS = ["all", "mod", "config", "resource", "other"];

export function FileManager({
  buildId,
  files,
  onChanged,
}: {
  buildId: number;
  files: BuildFile[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [dir, setDir] = useState("");
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<BuildFile | null>(null);
  // Файл, чьи свойства открыты в выезжающей панели справа.
  const [editingProps, setEditingProps] = useState<BuildFile | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  // Активный диалог создания: папка или файл.
  const [creating, setCreating] = useState<"folder" | "file" | null>(null);

  const searching = query.trim().length > 0 || kindFilter !== "all";

  const listing = useMemo(() => buildListing(files, dir), [files, dir]);

  // При активном поиске показываем плоский список совпадений по всем папкам.
  const searchResults = useMemo(() => {
    if (!searching) return [];
    const q = query.trim().toLowerCase();
    return files
      .filter((f) => {
        if (kindFilter !== "all" && f.kind !== kindFilter) return false;
        if (!q) return true;
        return (
          f.path.toLowerCase().includes(q) ||
          (f.displayName?.toLowerCase().includes(q) ?? false) ||
          (f.modId?.toLowerCase().includes(q) ?? false)
        );
      })
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [files, query, kindFilter, searching]);

  const crumbs = useMemo(() => {
    const norm = normalizeDir(dir);
    if (!norm) return [] as { name: string; path: string }[];
    const parts = norm.split("/");
    return parts.map((name, i) => ({
      name,
      path: parts.slice(0, i + 1).join("/"),
    }));
  }, [dir]);

  // Файлы, видимые в текущем представлении (для «выбрать всё»).
  const visibleFiles = searching ? searchResults : listing.files;
  const allVisibleSelected =
    visibleFiles.length > 0 && visibleFiles.every((f) => selected.has(f.id));

  function toggleOne(id: number) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((cur) => {
      const next = new Set(cur);
      if (allVisibleSelected) {
        for (const f of visibleFiles) next.delete(f.id);
      } else {
        for (const f of visibleFiles) next.add(f.id);
      }
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  async function removeFile(f: BuildFile) {
    const ok = await confirm({
      title: "Удалить файл?",
      body: f.path,
      confirmText: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteFile(f.id);
      toast.success("Файл удалён");
      onChanged();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось удалить файл",
      );
    }
  }

  async function saveFile(f: BuildFile, patch: Partial<BuildFile>) {
    await api.updateFile(f.id, {
      side: patch.side,
      kind: patch.kind,
      optional: patch.optional,
      enabledByDefault: patch.enabledByDefault,
      overwrite: patch.overwrite,
      modId: patch.modId ?? undefined,
      displayName: patch.displayName ?? undefined,
      description: patch.description ?? undefined,
    });
    toast.success("Файл обновлён");
    onChanged();
  }

  // Применяет один и тот же патч ко всем выбранным файлам.
  async function bulkPatch(patch: Partial<BuildFile>, label: string) {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    let failed = 0;
    for (const id of ids) {
      try {
        await api.updateFile(id, {
          side: patch.side,
          kind: patch.kind,
          optional: patch.optional,
          enabledByDefault: patch.enabledByDefault,
          overwrite: patch.overwrite,
        });
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    if (failed) toast.error(`Не удалось обновить файлов: ${failed}`);
    else toast.success(`${label}: ${ids.length} файл(ов)`);
    onChanged();
  }

  async function bulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const ok = await confirm({
      title: "Удалить выбранные файлы?",
      body: `Будет удалено файлов: ${ids.length}`,
      confirmText: "Удалить всё",
      danger: true,
    });
    if (!ok) return;
    setBulkBusy(true);
    let failed = 0;
    for (const id of ids) {
      try {
        await api.deleteFile(id);
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    clearSelection();
    if (failed) toast.error(`Не удалось удалить файлов: ${failed}`);
    else toast.success(`Удалено файлов: ${ids.length}`);
    onChanged();
  }

  async function removeFolder(folder: FolderEntry) {
    const prefix = folder.path + "/";
    const victims = files.filter((f) => f.path.startsWith(prefix));
    const ok = await confirm({
      title: "Удалить папку?",
      body: `${folder.path} — будет удалено файлов: ${victims.length}`,
      confirmText: "Удалить всё",
      danger: true,
    });
    if (!ok) return;
    setBulkBusy(true);
    let failed = 0;
    for (const f of victims) {
      try {
        await api.deleteFile(f.id);
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    if (failed) {
      toast.error(`Не удалось удалить файлов: ${failed}`);
    } else {
      toast.success(`Папка удалена (${victims.length} файлов)`);
    }
    onChanged();
  }

  const empty = listing.folders.length === 0 && listing.files.length === 0;

  // При «создать папку» просто переходим в неё: хранилище плоское, папка
  // «материализуется», как только в неё попадёт файл.
  function createFolder(name: string) {
    const clean = normalizeDir(name);
    if (!clean) return;
    setQuery("");
    setKindFilter("all");
    setDir(dir ? `${dir}/${clean}` : clean);
  }

  // Создаёт пустой файл в текущем каталоге и открывает редактор.
  async function createFile(name: string) {
    const fileName = name.trim().replace(/^\/+/, "");
    if (!fileName) return;
    const path = dir ? `${dir}/${fileName}` : fileName;
    if (files.some((f) => f.path === path)) {
      toast.error("Файл с таким путём уже есть");
      return;
    }
    try {
      const created = await api.createFile(buildId, {
        path,
        kind: guessKind(path),
        side: "both",
      });
      toast.success("Файл создан");
      onChanged();
      if (isEditable(created)) setEditing(created);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось создать файл",
      );
    }
  }

  return (
    <div className="fm">
      <div className="fm-toolbar">
        <nav className="breadcrumbs">
          <button
            className={`crumb${dir === "" ? " current" : ""}`}
            onClick={() => setDir("")}
            title=".minecraft"
          >
            <IconHome size={15} />
            <span>.minecraft</span>
          </button>
          {crumbs.map((c) => (
            <span key={c.path} className="crumb-wrap">
              <IconChevronRight size={14} className="crumb-sep" />
              <button
                className={`crumb${dir === c.path ? " current" : ""}`}
                onClick={() => setDir(c.path)}
              >
                {c.name}
              </button>
            </span>
          ))}
        </nav>
        <div className="spacer" />
        <NewMenu
          onFolder={() => setCreating("folder")}
          onFile={() => setCreating("file")}
        />
        <div className="seg">
          {KIND_FILTERS.map((k) => (
            <button
              key={k}
              className={`seg-btn${kindFilter === k ? " active" : ""}`}
              onClick={() => setKindFilter(k)}
            >
              {k === "all" ? "все" : k}
            </button>
          ))}
        </div>
        <div className="search">
          <IconSearch />
          <input
            placeholder="Поиск по всем папкам"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {selected.size > 0 && (
        <BulkBar
          count={selected.size}
          busy={bulkBusy}
          onSide={(s) => bulkPatch({ side: s }, `Сторона → ${sideLabel(s)}`)}
          onKind={(k) => bulkPatch({ kind: k }, `Тип → ${k}`)}
          onOptional={(v) =>
            bulkPatch(
              { optional: v },
              v ? "Помечены опциональными" : "Сняты опциональные",
            )
          }
          onEnabled={(v) =>
            bulkPatch(
              { enabledByDefault: v },
              v ? "Вкл. по умолчанию" : "Выкл. по умолчанию",
            )
          }
          onOverwrite={(v) =>
            bulkPatch(
              { overwrite: v },
              v ? "Перезаписывать" : "Не перезаписывать",
            )
          }
          onDelete={bulkDelete}
          onClear={clearSelection}
        />
      )}

      {searching ? (
        searchResults.length === 0 ? (
          <p className="muted fm-empty">Ничего не найдено.</p>
        ) : (
          <div className="fm-list">
            <SelectAllRow
              checked={allVisibleSelected}
              count={visibleFiles.length}
              onToggle={toggleAllVisible}
            />
            {searchResults.map((f) => (
              <FileRow
                key={f.id}
                file={f}
                selected={selected.has(f.id)}
                active={editingProps?.id === f.id}
                onToggle={() => toggleOne(f.id)}
                onDelete={() => removeFile(f)}
                onEditProps={() => setEditingProps(f)}
                onEdit={() => setEditing(f)}
                onOpenDir={(d) => {
                  setQuery("");
                  setKindFilter("all");
                  setDir(d);
                }}
              />
            ))}
          </div>
        )
      ) : (
        <div className="fm-list">
          {dir !== "" && (
            <div className="fm-row up">
              <button
                className="fm-main"
                onClick={() => setDir(parentDir(dir))}
              >
                <IconCornerUp size={17} className="fm-icon" />
                <span className="fm-name">..</span>
                <span className="fm-meta muted">наверх</span>
              </button>
            </div>
          )}

          {empty && (
            <p className="muted fm-empty">
              Папка пуста. Перетащите файлы ниже, чтобы загрузить их сюда.
            </p>
          )}

          {visibleFiles.length > 0 && (
            <SelectAllRow
              checked={allVisibleSelected}
              count={visibleFiles.length}
              onToggle={toggleAllVisible}
            />
          )}

          {listing.folders.map((folder) => (
            <div key={folder.path} className="fm-row folder">
              <button className="fm-main" onClick={() => setDir(folder.path)}>
                <IconFolder size={17} className="fm-icon folder" />
                <span className="fm-name">{folder.name}</span>
                <span className="fm-meta muted">
                  {folder.fileCount} файл(ов) · {formatSize(folder.totalSize)}
                </span>
              </button>
              <div className="fm-actions">
                <button
                  className="danger icon-only"
                  title="Удалить папку"
                  onClick={() => removeFolder(folder)}
                >
                  <IconTrash size={15} />
                </button>
              </div>
            </div>
          ))}

          {listing.files.map((f) => (
            <FileRow
              key={f.id}
              file={f}
              selected={selected.has(f.id)}
              active={editingProps?.id === f.id}
              onToggle={() => toggleOne(f.id)}
              onDelete={() => removeFile(f)}
              onEditProps={() => setEditingProps(f)}
              onEdit={() => setEditing(f)}
            />
          ))}
        </div>
      )}

      <FileUpload buildId={buildId} onUploaded={onChanged} baseDir={dir} />

      {editing && (
        <FileEditor
          file={editing}
          onClose={() => setEditing(null)}
          onSaved={onChanged}
        />
      )}

      {editingProps && (
        <FileSettingsDrawer
          file={editingProps}
          onClose={() => setEditingProps(null)}
          onSave={async (patch) => {
            await saveFile(editingProps, patch);
          }}
        />
      )}

      {creating && (
        <PromptDialog
          title={creating === "folder" ? "Новая папка" : "Новый файл"}
          label={
            creating === "folder"
              ? `Имя папки в ${dir ? `.minecraft/${dir}/` : ".minecraft/"}`
              : `Имя файла в ${dir ? `.minecraft/${dir}/` : ".minecraft/"}`
          }
          placeholder={
            creating === "folder" ? "напр. mods" : "напр. options.txt"
          }
          confirmText="Создать"
          hint={
            creating === "folder"
              ? "Папка сохранится после того, как в неё попадёт хотя бы один файл."
              : undefined
          }
          onCancel={() => setCreating(null)}
          onSubmit={async (value) => {
            if (creating === "folder") {
              createFolder(value);
              setCreating(null);
            } else {
              await createFile(value);
              setCreating(null);
            }
          }}
        />
      )}
    </div>
  );
}

function BulkBar({
  count,
  busy,
  onSide,
  onKind,
  onOptional,
  onEnabled,
  onOverwrite,
  onDelete,
  onClear,
}: {
  count: number;
  busy: boolean;
  onSide: (s: string) => void;
  onKind: (k: string) => void;
  onOptional: (v: boolean) => void;
  onEnabled: (v: boolean) => void;
  onOverwrite: (v: boolean) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div className="fm-bulk">
      <div className="fm-bulk-count">
        <span className="fm-bulk-badge">{count}</span>
        <span>выбрано</span>
      </div>

      <div className="fm-bulk-controls">
        <div className="fm-bulk-group">
          <span className="fm-bulk-label">Сторона</span>
          <div className="seg">
            {SIDES.map((s) => (
              <button
                key={s}
                className="seg-btn"
                disabled={busy}
                onClick={() => onSide(s)}
              >
                {sideLabel(s)}
              </button>
            ))}
          </div>
        </div>

        <div className="fm-bulk-group">
          <span className="fm-bulk-label">Тип</span>
          <div className="seg">
            {KINDS.map((k) => (
              <button
                key={k}
                className="seg-btn"
                disabled={busy}
                onClick={() => onKind(k)}
              >
                {k}
              </button>
            ))}
          </div>
        </div>

        <div className="fm-bulk-group">
          <span className="fm-bulk-label">Опциональный</span>
          <div className="seg">
            <button
              className="seg-btn"
              disabled={busy}
              onClick={() => onOptional(true)}
            >
              да
            </button>
            <button
              className="seg-btn"
              disabled={busy}
              onClick={() => onOptional(false)}
            >
              нет
            </button>
          </div>
        </div>

        <div className="fm-bulk-group">
          <span className="fm-bulk-label">По умолч.</span>
          <div className="seg">
            <button
              className="seg-btn"
              disabled={busy}
              onClick={() => onEnabled(true)}
            >
              вкл
            </button>
            <button
              className="seg-btn"
              disabled={busy}
              onClick={() => onEnabled(false)}
            >
              выкл
            </button>
          </div>
        </div>

        <div className="fm-bulk-group">
          <span className="fm-bulk-label">Перезапись</span>
          <div className="seg">
            <button
              className="seg-btn"
              disabled={busy}
              onClick={() => onOverwrite(true)}
            >
              да
            </button>
            <button
              className="seg-btn"
              disabled={busy}
              onClick={() => onOverwrite(false)}
            >
              нет
            </button>
          </div>
        </div>
      </div>

      <div className="fm-bulk-actions">
        <button className="danger" disabled={busy} onClick={onDelete}>
          <IconTrash size={15} />
          Удалить
        </button>
        <button className="ghost" disabled={busy} onClick={onClear}>
          Снять
        </button>
      </div>
    </div>
  );
}

// Выпадающее меню «Создать»: папка или файл в текущем каталоге.
function NewMenu({
  onFolder,
  onFile,
}: {
  onFolder: () => void;
  onFile: () => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onDoc() {
      setOpen(false);
    }
    window.addEventListener("click", onDoc);
    return () => window.removeEventListener("click", onDoc);
  }, [open]);

  return (
    <div className="fm-newmenu" onClick={(e) => e.stopPropagation()}>
      <button
        className={`primary${open ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <IconPlus size={15} />
        Создать
      </button>
      {open && (
        <div className="fm-newmenu-pop">
          <button
            className="fm-newmenu-item"
            onClick={() => {
              setOpen(false);
              onFolder();
            }}
          >
            <IconFolder size={15} className="folder" />
            Папку
          </button>
          <button
            className="fm-newmenu-item"
            onClick={() => {
              setOpen(false);
              onFile();
            }}
          >
            <IconFile size={15} />
            Файл
          </button>
        </div>
      )}
    </div>
  );
}

// Модальный ввод строки (имя папки/файла).
function PromptDialog({
  title,
  label,
  placeholder,
  confirmText,
  hint,
  onCancel,
  onSubmit,
}: {
  title: string;
  label: string;
  placeholder?: string;
  confirmText: string;
  hint?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useBodyScrollLock();

  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function submit() {
    if (value.trim()) onSubmit(value.trim());
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{title}</h3>
        <label className="fm-prompt-field">
          <span className="muted">{label}</span>
          <input
            ref={inputRef}
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </label>
        {hint && <p className="muted fm-prompt-hint">{hint}</p>}
        <div className="modal-actions">
          <button onClick={onCancel}>Отмена</button>
          <button className="primary" onClick={submit} disabled={!value.trim()}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

function SelectAllRow({
  checked,
  count,
  onToggle,
}: {
  checked: boolean;
  count: number;
  onToggle: () => void;
}) {
  return (
    <label className="fm-selectall">
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <span className="muted">
        {checked ? "Снять выделение" : `Выбрать все (${count})`}
      </span>
    </label>
  );
}

function FileRow({
  file,
  selected,
  active,
  onToggle,
  onDelete,
  onEditProps,
  onEdit,
  onOpenDir,
}: {
  file: BuildFile;
  selected: boolean;
  active: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onEditProps: () => void;
  onEdit: () => void;
  onOpenDir?: (dir: string) => void;
}) {
  const editable = isEditable(file);

  return (
    <div
      className={`fm-row file${active ? " editing" : ""}${
        selected ? " selected" : ""
      }`}
    >
      <label className="fm-check">
        <input type="checkbox" checked={selected} onChange={onToggle} />
      </label>
      <div className="fm-main static">
        <IconFile size={16} className="fm-icon file" />
        <span className="fm-name">{baseName(file.path)}</span>
        <span className={`tag kind-${file.kind}`}>{file.kind}</span>
        {onOpenDir && parentDir(file.path) && (
          <button
            className="fm-path-link muted"
            onClick={() => onOpenDir(parentDir(file.path))}
            title="Открыть папку"
          >
            {parentDir(file.path)}/
          </button>
        )}
        {file.optional && (
          <span className="tag">опц.{file.enabledByDefault ? "✓" : "✗"}</span>
        )}
        {!file.overwrite && <span className="tag">no-ow</span>}
        {file.displayName && (
          <span className="fm-disp muted">{file.displayName}</span>
        )}
        {file.description && (
          <span className="fm-disp muted" title={file.description}>
            — {file.description}
          </span>
        )}
        <span className="fm-meta muted">{file.side}</span>
        <span className="mono muted fm-sha" title={file.sha1}>
          {shortSha(file.sha1)}
        </span>
        <span className="fm-size num">{formatSize(file.sizeBytes)}</span>
      </div>
      <div className="fm-actions">
        {editable && (
          <button
            className="icon-only"
            title="Редактировать текст"
            onClick={onEdit}
          >
            <IconPencil size={15} />
          </button>
        )}
        <button
          className={`link-btn${active ? " active" : ""}`}
          title="Свойства файла"
          onClick={onEditProps}
        >
          свойства
        </button>
        <a
          className="icon-only"
          href={`/files/${file.sha1}`}
          download={baseName(file.path)}
          title="Скачать"
        >
          <IconDownload size={15} />
        </a>
        <button
          className="danger icon-only"
          title="Удалить файл"
          onClick={onDelete}
        >
          <IconTrash size={15} />
        </button>
      </div>
    </div>
  );
}

// Выезжающая сбоку панель свойств файла. Раньше это был ряд контролов прямо
// внутри строки файла, но по ширине он не помещался даже на ПК. Теперь
// настройки (сторона, тип, опциональность и т.д.) разложены вертикально.
function FileSettingsDrawer({
  file,
  onClose,
  onSave,
}: {
  file: BuildFile;
  onClose: () => void;
  onSave: (patch: Partial<BuildFile>) => Promise<void>;
}) {
  const toast = useToast();
  const [side, setSide] = useState(file.side);
  const [kind, setKind] = useState(file.kind);
  const [optional, setOptional] = useState(file.optional);
  const [enabledByDefault, setEnabledByDefault] = useState(
    file.enabledByDefault,
  );
  const [overwrite, setOverwrite] = useState(file.overwrite);
  const [modId, setModId] = useState(file.modId ?? "");
  const [displayName, setDisplayName] = useState(file.displayName ?? "");
  const [description, setDescription] = useState(file.description ?? "");
  const [saving, setSaving] = useState(false);

  useBodyScrollLock();

  // При выборе другого файла подставляем его значения.
  useEffect(() => {
    setSide(file.side);
    setKind(file.kind);
    setOptional(file.optional);
    setEnabledByDefault(file.enabledByDefault);
    setOverwrite(file.overwrite);
    setModId(file.modId ?? "");
    setDisplayName(file.displayName ?? "");
    setDescription(file.description ?? "");
  }, [file]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    setSaving(true);
    try {
      await onSave({
        side,
        kind,
        optional,
        enabledByDefault,
        overwrite,
        modId: optional ? modId.trim() || null : null,
        displayName: displayName.trim() || null,
        description: description.trim() || null,
      });
      onClose();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось сохранить",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fm-drawer-backdrop" onClick={onClose}>
      <aside
        className="fm-drawer"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="fm-drawer-head">
          <div className="fm-drawer-title">
            <span className="fm-drawer-eyebrow muted">Свойства файла</span>
            <strong title={file.path}>{baseName(file.path)}</strong>
          </div>
          <button className="icon-only" title="Закрыть" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </header>

        <div className="fm-drawer-body">
          <div className="fm-drawer-field">
            <span className="fm-edit-label muted">Сторона</span>
            <div className="seg">
              {SIDES.map((s) => (
                <button
                  key={s}
                  className={`seg-btn${side === s ? " active" : ""}`}
                  onClick={() => setSide(s)}
                >
                  {sideLabel(s)}
                </button>
              ))}
            </div>
          </div>

          <div className="fm-drawer-field">
            <span className="fm-edit-label muted">Тип</span>
            <div className="seg">
              {KINDS.map((k) => (
                <button
                  key={k}
                  className={`seg-btn${kind === k ? " active" : ""}`}
                  onClick={() => setKind(k)}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>

          <label className="fm-edit-check">
            <input
              type="checkbox"
              checked={optional}
              onChange={(e) => {
                const v = e.target.checked;
                setOptional(v);
                // Подставляем modId из имени файла при включении, если пусто.
                if (v && !modId.trim()) setModId(slugifyModId(file.path));
              }}
            />
            <span>Опциональный</span>
          </label>

          <label
            className={`fm-edit-check${optional ? "" : " disabled"}`}
            title={optional ? "" : "Только для опциональных"}
          >
            <input
              type="checkbox"
              checked={enabledByDefault}
              disabled={!optional}
              onChange={(e) => setEnabledByDefault(e.target.checked)}
            />
            <span>Вкл. по умолчанию</span>
          </label>

          {optional && (
            <div className="fm-drawer-field">
              <span
                className="fm-edit-label muted"
                title="Стабильный идентификатор мода. По нему лаунчер запоминает выбор игрока — выбор не сбросится при обновлении/переименовании файла. Обычно modid или slug."
              >
                modId
              </span>
              <input
                className="fm-edit-input"
                placeholder="напр. sodium"
                value={modId}
                onChange={(e) => setModId(e.target.value)}
              />
            </div>
          )}

          <label className="fm-edit-check">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            <span>Перезаписывать</span>
          </label>

          <div className="fm-drawer-field">
            <span className="fm-edit-label muted">Имя</span>
            <input
              className="fm-edit-input"
              placeholder="Отображаемое имя"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          <div className="fm-drawer-field">
            <span className="fm-edit-label muted">Описание</span>
            <input
              className="fm-edit-input"
              placeholder="Короткое описание"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        <footer className="fm-drawer-foot">
          <button className="ghost" onClick={onClose}>
            Отмена
          </button>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? "…" : "Сохранить"}
          </button>
        </footer>
      </aside>
    </div>
  );
}
