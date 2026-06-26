// Файловый менеджер сборки в стиле панелей вроде Pterodactyl.
//
// Сервер хранит файлы плоским списком с полным путём относительно `.minecraft`
// (напр. `config/foo/bar.toml`). Дерево каталогов мы строим на лету из этих
// путей: навигация по папкам, хлебные крошки, скачивание и удаление.

import { useMemo, useState } from "react";
import { api, ApiError } from "./api";
import type { BuildFile } from "./types";
import { FileUpload } from "./FileUpload";
import {
  baseName,
  formatSize,
  normalizeDir,
  parentDir,
  shortSha,
} from "./format";
import { useConfirm, useToast } from "./ui/feedback";
import {
  IconChevronRight,
  IconCornerUp,
  IconDownload,
  IconFile,
  IconFolder,
  IconHome,
  IconPencil,
  IconSearch,
  IconTrash,
} from "./ui/icons";

const SIDES = ["both", "client", "server"];

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
      optional: patch.optional,
      enabledByDefault: patch.enabledByDefault,
      overwrite: patch.overwrite,
    });
    toast.success("Файл обновлён");
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
    let failed = 0;
    for (const f of victims) {
      try {
        await api.deleteFile(f.id);
      } catch {
        failed++;
      }
    }
    if (failed) {
      toast.error(`Не удалось удалить файлов: ${failed}`);
    } else {
      toast.success(`Папка удалена (${victims.length} файлов)`);
    }
    onChanged();
  }

  const empty = listing.folders.length === 0 && listing.files.length === 0;

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

      {searching ? (
        <SearchTable
          results={searchResults}
          onOpenDir={(d) => {
            setQuery("");
            setKindFilter("all");
            setDir(d);
          }}
          onDelete={removeFile}
          onSave={saveFile}
        />
      ) : (
        <div className="fm-list">
          {dir !== "" && (
            <button
              className="fm-row up"
              onClick={() => setDir(parentDir(dir))}
            >
              <IconCornerUp size={16} className="fm-icon" />
              <span className="fm-name">..</span>
            </button>
          )}

          {empty && (
            <p className="muted fm-empty">
              Папка пуста. Перетащите файлы ниже, чтобы загрузить их сюда.
            </p>
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
              onDelete={() => removeFile(f)}
              onSave={(patch) => saveFile(f, patch)}
            />
          ))}
        </div>
      )}

      <FileUpload
        buildId={buildId}
        onUploaded={onChanged}
        baseDir={searching ? "" : dir}
      />
    </div>
  );
}

function FileRow({
  file,
  onDelete,
  onSave,
  onOpenDir,
}: {
  file: BuildFile;
  onDelete: () => void;
  onSave: (patch: Partial<BuildFile>) => Promise<void>;
  onOpenDir?: (dir: string) => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [side, setSide] = useState(file.side);
  const [optional, setOptional] = useState(file.optional);
  const [enabledByDefault, setEnabledByDefault] = useState(
    file.enabledByDefault,
  );
  const [overwrite, setOverwrite] = useState(file.overwrite);
  const [saving, setSaving] = useState(false);

  function open() {
    setSide(file.side);
    setOptional(file.optional);
    setEnabledByDefault(file.enabledByDefault);
    setOverwrite(file.overwrite);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    try {
      await onSave({ side, optional, enabledByDefault, overwrite });
      setEditing(false);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось сохранить",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`fm-row file${editing ? " editing" : ""}`}>
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
        <span className="fm-meta muted">{file.side}</span>
        <span className="mono muted fm-sha" title={file.sha1}>
          {shortSha(file.sha1)}
        </span>
        <span className="fm-size num">{formatSize(file.sizeBytes)}</span>
      </div>
      <div className="fm-actions">
        <button
          className={`icon-only${editing ? " active" : ""}`}
          title="Редактировать"
          onClick={() => (editing ? setEditing(false) : open())}
        >
          <IconPencil size={15} />
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

      {editing && (
        <div className="fm-edit">
          <div className="fm-edit-field">
            <span className="fm-edit-label muted">Сторона</span>
            <div className="seg">
              {SIDES.map((s) => (
                <button
                  key={s}
                  className={`seg-btn${side === s ? " active" : ""}`}
                  onClick={() => setSide(s)}
                >
                  {s === "both" ? "обе" : s === "client" ? "клиент" : "сервер"}
                </button>
              ))}
            </div>
          </div>

          <label className="fm-edit-check">
            <input
              type="checkbox"
              checked={optional}
              onChange={(e) => setOptional(e.target.checked)}
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

          <label className="fm-edit-check">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            <span>Перезаписывать</span>
          </label>

          <div className="spacer" />
          <button className="ghost" onClick={() => setEditing(false)}>
            Отмена
          </button>
          <button className="primary" onClick={save} disabled={saving}>
            {saving ? "…" : "Сохранить"}
          </button>
        </div>
      )}
    </div>
  );
}

function SearchTable({
  results,
  onOpenDir,
  onDelete,
  onSave,
}: {
  results: BuildFile[];
  onOpenDir: (dir: string) => void;
  onDelete: (f: BuildFile) => void;
  onSave: (f: BuildFile, patch: Partial<BuildFile>) => Promise<void>;
}) {
  if (results.length === 0) {
    return <p className="muted fm-empty">Ничего не найдено.</p>;
  }
  return (
    <div className="fm-list">
      {results.map((f) => (
        <FileRow
          key={f.id}
          file={f}
          onDelete={() => onDelete(f)}
          onSave={(patch) => onSave(f, patch)}
          onOpenDir={onOpenDir}
        />
      ))}
    </div>
  );
}
