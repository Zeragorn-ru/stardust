// Детали сборки: файлы, метаданные, профили опциональных модов, установка
// модов, синк на сервер, проверки. Функциональность прежняя — интерфейс новый.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, type SyncStatus } from "../../api";
import type { BuildDetail, BuildFile, ModProfile } from "../../types";
import { useAsyncData } from "../../ui/useAsyncData";
import {
  Button,
  Checkbox,
  Chip,
  CopyButton,
  EllipsisCell,
  EmptyState,
  Field,
  Form,
  FormActions,
  IconButton,
  Input,
  Modal,
  PageHeader,
  PageState,
  Panel,
  ProgressBar,
  Select,
  Switch,
  Table,
  Tabs,
  Textarea,
  useContextMenu,
} from "../../ui/components";
import { useToast, useConfirm } from "../../ui/feedback";
import { useSftpHostKey } from "../../ui/sftpHostKey";
import { formatSize, shortSha } from "../../format";
import { KINDS, SIDES, guessKind } from "../../fileUtils";
import { slugifyModId } from "../../format";
import { ModSearch } from "./ModSearch";
import {
  IconArrowLeft,
  IconDownload,
  IconFile,
  IconPencil,
  IconPlus,
  IconRefresh,
  IconSync,
  IconTrash,
  IconUpload,
} from "../../ui/icons";

export function BuildDetail({ id }: { id: number }) {
  const navigate = useNavigate();
  const fetcher = useCallback(() => api.getBuild(id), [id]);
  const { data, loading, error, reload } = useAsyncData(fetcher, { pollMs: 15000 });

  const [tab, setTab] = useState<"files" | "profiles" | "install" | "ops">("files");

  if (loading && !data) {
    return (
      <PageState loading error={null}>
        {null}
      </PageState>
    );
  }
  if (error && !data) {
    return <PageState loading={false} error={error} onRetry={reload}>{null}</PageState>;
  }
  if (!data) return null;

  const build = data;

  return (
    <div className="page-stack">
      <PageHeader
        title={build.name}
        actions={
          <>
            {build.isActive ? <Chip tone="accent">активная</Chip> : <Chip>неактивная</Chip>}
            <Button icon={<IconArrowLeft size={15} />} onClick={() => navigate("/builds")}>
              К списку
            </Button>
          </>
        }
      />

      <div className="build-meta">
        <span className="mono">{build.mcVersion}</span>
        <span className="faint">·</span>
        <span>{build.loaderKind}</span>
        <span className="faint">·</span>
        <span className="mono">{build.loaderVersion}</span>
        <span className="faint">·</span>
        <span>{build.files.length} файлов</span>
      </div>

      <Tabs
        tabs={[
          { key: "files", label: `Файлы (${build.files.length})` },
          { key: "profiles", label: `Профили (${build.modProfiles.length})` },
          { key: "install", label: "Установка модов" },
          { key: "ops", label: "Операции" },
        ]}
        active={tab}
        onSelect={setTab}
      />

      {tab === "files" && <FilesTab build={build} onChanged={reload} />}
      {tab === "profiles" && <ProfilesTab build={build} onChanged={reload} />}
      {tab === "install" && <InstallTab build={build} onInstalled={reload} />}
      {tab === "ops" && (
        <OpsTab
          build={build}
          onChanged={reload}
          onDeleted={() => navigate("/builds")}
          onCloned={(created) => navigate(`/builds/${created.id}`)}
        />
      )}
    </div>
  );
}

// ───────────────────────── Файлы ─────────────────────────

function FilesTab({ build, onChanged }: { build: BuildDetail; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const openMenu = useContextMenu();
  const [dir, setDir] = useState("");
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<BuildFile | null>(null);
  const [editor, setEditor] = useState<BuildFile | null>(null);

  // Каталоги верхнего уровня из путей файлов.
  const dirs = useMemo(() => {
    const set = new Set<string>();
    for (const file of build.files) {
      const i = file.path.indexOf("/");
      set.add(i >= 0 ? file.path.slice(0, i) : "(корень)");
    }
    return Array.from(set).sort();
  }, [build.files]);

  const visible = useMemo(
    () =>
      build.files
        .filter((file) => {
          const top = file.path.includes("/") ? file.path.slice(0, file.path.indexOf("/")) : "(корень)";
          return dir === "" || top === dir;
        })
        .sort((a, b) => a.path.localeCompare(b.path)),
    [build.files, dir],
  );

  async function deleteFile(file: BuildFile) {
    const ok = await confirm({
      title: `Удалить ${file.path}?`,
      confirmText: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteFile(file.id);
      toast.success("Файл удалён");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось удалить файл");
    }
  }

  return (
    <Panel
      flush
      title="Файлы сборки"
      description="Контент-адресное хранилище: каждый файл регистрируется по SHA-1."
      actions={
        <>
          <Button size="sm" icon={<IconUpload size={14} />} onClick={() => setUploading(true)}>
            Загрузить
          </Button>
          <Button size="sm" icon={<IconPencil size={14} />} disabled={!editing} onClick={() => editing && setEditor(editing)}>
            Редактор
          </Button>
        </>
      }
    >
      <div className="files-toolbar">
        <Select value={dir} onChange={(e) => setDir(e.target.value)} aria-label="Каталог">
          <option value="">Все каталоги</option>
          {dirs.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
      </div>

      <Table
        columns={[
          { key: "path", label: "Путь" },
          { key: "side", label: "Сторона", width: "90px" },
          { key: "kind", label: "Тип", width: "90px" },
          { key: "size", label: "Размер", width: "90px", align: "right" },
          { key: "flags", label: "Флаги", width: "180px" },
          { key: "sha", label: "SHA-1", width: "140px" },
          { key: "actions", label: "", width: "90px", align: "right" },
        ]}
        empty={
          <EmptyState
            title="Файлов нет"
            body="Загрузите моды и конфиги, либо установите моды из каталога."
            action={
              <Button variant="primary" icon={<IconUpload size={15} />} onClick={() => setUploading(true)}>
                Загрузить файлы
              </Button>
            }
          />
        }
        rows={visible.map((file) => ({
          key: String(file.id),
          className: file.disabled ? "row-muted" : undefined,
          cells: {
            path: (
              <span
                className="ellipsis mono"
                title={file.path}
                onContextMenu={(e) =>
                  openMenu(e, [
                    { label: "Изменить метаданные", icon: <IconPencil size={14} />, onSelect: () => setEditing(file) },
                    ...(isTextFile(file.path)
                      ? [{ label: "Открыть в редакторе", icon: <IconFile size={14} />, onSelect: () => setEditor(file) }]
                      : []),
                    { label: "Удалить", icon: <IconTrash size={14} />, danger: true, onSelect: () => void deleteFile(file) },
                  ])
                }
              >
                {file.path}
              </span>
            ),
            side: file.side,
            kind: file.kind,
            size: formatSize(file.sizeBytes),
            flags: (
              <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                {file.overwrite && <Chip tone="warn">overwrite</Chip>}
                {file.optional && <Chip tone="info">optional</Chip>}
                {file.disabled && <Chip tone="err">выкл</Chip>}
                {file.profiles.length > 0 && <Chip title={file.profiles.join(", ")}>{file.profiles.length} проф.</Chip>}
              </span>
            ),
            sha: (
              <span className="row" style={{ gap: 4 }}>
                <span className="mono faint">{shortSha(file.sha1)}</span>
                <CopyButton text={file.sha1} />
              </span>
            ),
            actions: (
              <span className="row" style={{ justifyContent: "flex-end" }}>
                {isTextFile(file.path) && (
                  <IconButton label="Редактировать" size="sm" onClick={() => setEditor(file)}>
                    <IconFile size={14} />
                  </IconButton>
                )}
                <IconButton label="Метаданные" size="sm" onClick={() => setEditing(file)}>
                  <IconPencil size={14} />
                </IconButton>
                <IconButton label="Удалить" size="sm" onClick={() => void deleteFile(file)}>
                  <IconTrash size={14} />
                </IconButton>
              </span>
            ),
          },
        }))}
      />

      {uploading && (
        <UploadModal
          buildId={build.id}
          existingPaths={build.files.map((f) => f.path)}
          onClose={() => setUploading(false)}
          onDone={() => {
            setUploading(false);
            onChanged();
          }}
        />
      )}

      {editing && (
        <FileMetaModal
          file={editing}
          profiles={build.modProfiles}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}

      {editor && (
        <TextFileModal
          file={editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            onChanged();
          }}
        />
      )}
    </Panel>
  );
}

function isTextFile(path: string): boolean {
  return /\.(txt|json|toml|cfg|conf|properties|md|yml|yaml|csv|log|mcmeta|html|css|js|ts)$/i.test(path) ||
    !path.includes(".");
}

// ───────────────────────── Загрузка ─────────────────────────

function UploadModal({
  buildId,
  existingPaths,
  onClose,
  onDone,
}: {
  buildId: number;
  existingPaths: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState("");
  const [meta, setMeta] = useState({
    side: "both",
    kind: "mod",
    overwrite: false,
    optional: false,
    enabledByDefault: true,
  });
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    if (file && !path) setPath(`mods/${file.name}`);
  }, [file, path]);

  useEffect(() => {
    if (file) setMeta((m) => ({ ...m, kind: guessKind(file.name) }));
  }, [file]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    const finalPath = path.trim().replace(/^\/+/, "");
    if (!finalPath) return;
    setProgress(0);
    try {
      await api.uploadFileProgress(buildId, file, {
        path: finalPath,
        side: meta.side,
        kind: meta.kind,
        overwrite: meta.overwrite,
        optional: meta.optional,
        enabledByDefault: meta.enabledByDefault,
      }, setProgress);
      toast.success("Файл загружен");
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Загрузка не удалась");
      setProgress(null);
    }
  }

  const duplicate = file != null && existingPaths.includes(path.trim().replace(/^\/+/, ""));

  return (
    <Modal title="Загрузка файла" onClose={onClose}>
      <form onSubmit={submit}>
        <Form>
          <Field label="Файл" wide>
            <input
              className="input"
              type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
          </Field>
          <Field label="Путь в сборке" hint="Каталог определяет назначение: mods/, config/…" wide>
            <Input value={path} onChange={(e) => setPath(e.target.value)} required className="mono" />
          </Field>
          {duplicate && (
            <div className="stale-banner" style={{ borderRadius: "var(--radius)" }}>
              Файл с таким путём уже есть — включите overwrite для замены.
            </div>
          )}
          <Field label="Сторона">
            <Select value={meta.side} onChange={(e) => setMeta((m) => ({ ...m, side: e.target.value }))}>
              {SIDES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Тип">
            <Select value={meta.kind} onChange={(e) => setMeta((m) => ({ ...m, kind: e.target.value }))}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </Select>
          </Field>
          <Field label="Флаги" wide>
            <div className="flags-row">
              <Switch checked={meta.overwrite} onChange={(v) => setMeta((m) => ({ ...m, overwrite: v }))} label="Заменять существующий" />
              <Switch checked={meta.optional} onChange={(v) => setMeta((m) => ({ ...m, optional: v }))} label="Опциональный" />
              {meta.optional && (
                <Checkbox
                  checked={meta.enabledByDefault}
                  onChange={(v) => setMeta((m) => ({ ...m, enabledByDefault: v }))}
                  label="Включён по умолчанию"
                />
              )}
            </div>
          </Field>
          {progress != null && (
            <div className="field-wide">
              <ProgressBar value={progress} />
            </div>
          )}
          <FormActions>
            <Button type="button" variant="ghost" onClick={onClose}>Отмена</Button>
            <Button type="submit" variant="primary" busy={progress != null}>Загрузить</Button>
          </FormActions>
        </Form>
      </form>
    </Modal>
  );
}

// ───────────────────────── Метаданные файла ─────────────────────────

function FileMetaModal({
  file,
  profiles,
  onClose,
  onSaved,
}: {
  file: BuildFile;
  profiles: ModProfile[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [path, setPath] = useState(file.path);
  const [meta, setMeta] = useState({
    side: file.side,
    kind: file.kind,
    overwrite: file.overwrite,
    optional: file.optional,
    enabledByDefault: file.enabledByDefault,
    disabled: file.disabled,
    modId: file.modId ?? "",
    displayName: file.displayName ?? "",
    description: file.description ?? "",
    profiles: file.profiles,
  });
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.updateFile(file.id, {
        path: path.trim(),
        side: meta.side,
        kind: meta.kind,
        overwrite: meta.overwrite,
        optional: meta.optional,
        enabledByDefault: meta.enabledByDefault,
        disabled: meta.disabled,
        modId: meta.modId.trim() === "" ? null : meta.modId.trim(),
        displayName: meta.displayName.trim() === "" ? null : meta.displayName.trim(),
        description: meta.description.trim() === "" ? null : meta.description.trim(),
        profiles: meta.profiles,
      });
      toast.success("Метаданные сохранены");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Метаданные файла" onClose={onClose}>
      <form onSubmit={submit}>
        <Form>
          <Field label="Путь" wide>
            <Input value={path} onChange={(e) => setPath(e.target.value)} className="mono" required />
          </Field>
          <Field label="Сторона">
            <Select value={meta.side} onChange={(e) => setMeta((m) => ({ ...m, side: e.target.value }))}>
              {SIDES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Тип">
            <Select value={meta.kind} onChange={(e) => setMeta((m) => ({ ...m, kind: e.target.value }))}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </Select>
          </Field>
          <Field label="Mod ID" hint="Стабильный идентификатор для выборов игрока">
            <Input value={meta.modId} onChange={(e) => setMeta((m) => ({ ...m, modId: e.target.value }))} className="mono" placeholder={slugifyModId(file.path)} />
          </Field>
          <Field label="Отображаемое имя">
            <Input value={meta.displayName} onChange={(e) => setMeta((m) => ({ ...m, displayName: e.target.value }))} />
          </Field>
          <Field label="Описание" wide>
            <Textarea value={meta.description} onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))} rows={2} />
          </Field>
          <Field label="Флаги" wide>
            <div className="flags-row">
              <Switch checked={meta.overwrite} onChange={(v) => setMeta((m) => ({ ...m, overwrite: v }))} label="Заменять" />
              <Switch checked={meta.optional} onChange={(v) => setMeta((m) => ({ ...m, optional: v }))} label="Опциональный" />
              <Switch checked={meta.disabled} onChange={(v) => setMeta((m) => ({ ...m, disabled: v }))} label="Выключен" />
            </div>
          </Field>
          {profiles.length > 0 && (
            <Field label="Профили" hint="Пусто — файл общий, есть во всех профилях" wide>
              <div className="flags-row">
                {profiles.map((p) => (
                  <Checkbox
                    key={p.key}
                    checked={meta.profiles.includes(p.key)}
                    onChange={(v) =>
                      setMeta((m) => ({
                        ...m,
                        profiles: v ? [...m.profiles, p.key] : m.profiles.filter((k) => k !== p.key),
                      }))
                    }
                    label={p.name}
                  />
                ))}
              </div>
            </Field>
          )}
          <FormActions>
            <Button type="button" variant="ghost" onClick={onClose}>Отмена</Button>
            <Button type="submit" variant="primary" busy={busy}>Сохранить</Button>
          </FormActions>
        </Form>
      </form>
    </Modal>
  );
}

// ───────────────────────── Текстовый редактор ─────────────────────────

function TextFileModal({
  file,
  onClose,
  onSaved,
}: {
  file: BuildFile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [content, setContent] = useState<string | null>(null);
  const [baseSha1, setBaseSha1] = useState(file.sha1);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.getFileContent(file.sha1).then((text) => {
      if (!cancelled) setContent(text);
    }).catch((err) => {
      if (!cancelled) {
        toast.error(err instanceof Error ? err.message : "Не удалось прочитать файл");
        onClose();
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id]);

  async function save() {
    if (content == null) return;
    setBusy(true);
    try {
      const updated = await api.updateFileContent(file.id, content, baseSha1);
      setBaseSha1(updated.sha1);
      toast.success("Сохранено");
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error("Файл изменился после открытия — обновите страницу и повторите");
      } else {
        toast.error(err instanceof Error ? err.message : "Не удалось сохранить");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={file.path}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Закрыть</Button>
          <Button variant="primary" busy={busy} disabled={content == null} onClick={save}>
            Сохранить
          </Button>
        </>
      }
    >
      {content == null ? (
        <div className="page-state"><span className="spinner" />Чтение…</div>
      ) : (
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={22}
          className="mono"
          style={{ minHeight: "55vh", whiteSpace: "pre", fontFamily: "var(--mono)" }}
        />
      )}
    </Modal>
  );
}

// ───────────────────────── Профили опциональных модов ─────────────────────────

function ProfilesTab({ build, onChanged }: { build: BuildDetail; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ key: "", name: "", description: "" });

  async function createProfile(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.upsertModProfile(build.id, {
        key: draft.key.trim().toLowerCase(),
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
      });
      toast.success("Профиль создан");
      setCreating(false);
      setDraft({ key: "", name: "", description: "" });
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось создать профиль");
    }
  }

  async function removeProfile(profile: ModProfile) {
    const ok = await confirm({
      title: `Удалить профиль «${profile.name}»?`,
      body: "Файлы останутся, но потеряют привязку к этому профилю.",
      confirmText: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteModProfile(build.id, profile.key);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось удалить профиль");
    }
  }

  return (
    <Panel
      title="Профили опциональных модов"
      description="Пресеты вида «Производительность»: игрок выбирает один профиль, файлы включаются наборами."
      actions={
        <Button size="sm" icon={<IconPlus size={14} />} onClick={() => setCreating(true)}>
          Новый профиль
        </Button>
      }
    >
      {build.modProfiles.length === 0 && !creating ? (
        <EmptyState
          title="Профилей нет"
          body="Создайте профиль, чтобы группировать опциональные моды."
          action={<Button onClick={() => setCreating(true)}>Новый профиль</Button>}
        />
      ) : (
        <Table
          columns={[
            { key: "name", label: "Имя" },
            { key: "key", label: "Ключ" },
            { key: "desc", label: "Описание" },
            { key: "order", label: "Порядок", width: "90px", align: "right" },
            { key: "actions", label: "", width: "60px", align: "right" },
          ]}
          rows={build.modProfiles.map((p) => ({
            key: p.key,
            cells: {
              name: p.name,
              key: <span className="mono">{p.key}</span>,
              desc: <EllipsisCell text={p.description ?? "—"} />,
              order: p.sortOrder,
              actions: (
                <IconButton label="Удалить" size="sm" onClick={() => void removeProfile(p)}>
                  <IconTrash size={14} />
                </IconButton>
              ),
            },
          }))}
        />
      )}

      {creating && (
        <Modal title="Новый профиль" onClose={() => setCreating(false)}>
          <form onSubmit={createProfile}>
            <Form>
              <Field label="Ключ" hint="Латиница/цифры/дефис, например performance">
                <Input value={draft.key} onChange={(e) => setDraft((d) => ({ ...d, key: e.target.value }))} className="mono" required />
              </Field>
              <Field label="Название">
                <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} required />
              </Field>
              <Field label="Описание" wide>
                <Input value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
              </Field>
              <FormActions>
                <Button type="button" variant="ghost" onClick={() => setCreating(false)}>Отмена</Button>
                <Button type="submit" variant="primary">Создать</Button>
              </FormActions>
            </Form>
          </form>
        </Modal>
      )}
    </Panel>
  );
}

// ───────────────────────── Установка модов ─────────────────────────

function InstallTab({ build, onInstalled }: { build: BuildDetail; onInstalled: () => void }) {
  return (
    <Panel
      title="Каталог модов"
      description={`Установка напрямую с хостинга в сборку «${build.name}»: сервер сам скачивает файлы и считает SHA-1.`}
    >
      <ModSearch
        buildId={build.id}
        mcVersion={build.mcVersion}
        loader={build.loaderKind}
        profiles={build.modProfiles.map((p) => p.key)}
        onInstalled={onInstalled}
      />
    </Panel>
  );
}

// ───────────────────────── Операции ─────────────────────────

function OpsTab({
  build,
  onChanged,
  onDeleted,
  onCloned,
}: {
  build: BuildDetail;
  onChanged: () => void;
  onDeleted: () => void;
  onCloned: (created: { id: number }) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const { confirmHostKey } = useSftpHostKey();
  const [checks, setChecks] = useState<string | null>(null);
  const sync = useAsyncData(
    useCallback(() => api.syncToPanelStatus(build.id), [build.id]),
    { pollMs: 0 },
  );

  async function doSync() {
    try {
      await runSync();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data && typeof err.data === "object") {
        // SFTP-ключ сменился: показываем диалог подтверждения и повторяем.
        const change = (err.data as Record<string, unknown>).hostKeyChanged ?? err.data;
        const confirmation = await confirmHostKey(change as never);
        if (!confirmation) return;
        try {
          await runSync(confirmation);
        } catch (retryErr) {
          toast.error(retryErr instanceof Error ? retryErr.message : "Синхронизация не удалась");
        }
      } else {
        toast.error(err instanceof Error ? err.message : "Синхронизация не удалась");
      }
    }
  }

  async function runSync(confirmation?: Parameters<typeof api.syncToPanel>[1]) {
    const res = await api.syncToPanel(build.id, confirmation);
    if (res.inProgress) {
      toast.info("Синхронизация запущена");
    } else {
      toast.success(`Синхронизировано: загружено ${res.uploaded}, пропущено ${res.skipped}, удалено ${res.deleted}`);
    }
    sync.reload();
  }

  async function runChecks() {
    setChecks("Выполняется проверка…");
    try {
      const [buildCheck, depsCheck] = await Promise.all([
        api.buildCheck(build.id),
        api.depsCheck(build.id),
      ]);
      const lines: string[] = [];
      if (buildCheck.problems.length === 0 && depsCheck.problems.length === 0) {
        lines.push("Проблем не найдено.");
      }
      if (buildCheck.problems.length > 0) {
        lines.push(`Проверка файлов (${buildCheck.problems.length}):`);
        for (const p of buildCheck.problems) lines.push(`  ${p.path} — ${p.detail}`);
      }
      if (depsCheck.problems.length > 0) {
        lines.push(`Зависимости (${depsCheck.problems.length}):`);
        for (const p of depsCheck.problems) {
          lines.push(`  ${p.fromMod} требует ${p.requiredMod} (${p.versionRange})`);
        }
      }
      setChecks(lines.join("\n"));
    } catch (err) {
      setChecks("Ошибка проверки: " + (err instanceof Error ? err.message : ""));
    }
  }

  async function removeBuild() {
    const ok = await confirm({
      title: `Удалить сборку «${build.name}»?`,
      body: "Действие необратимо.",
      confirmText: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteBuild(build.id);
      toast.success("Сборка удалена");
      onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось удалить");
    }
  }

  const syncState: SyncStatus | null = sync.data;

  return (
    <div className="page-columns">
      <Panel
        title="Публикация на сервер"
        description="Загрузка файлов сборки на игровой сервер по SFTP."
        actions={
          <Button size="sm" icon={<IconSync size={14} />} onClick={doSync}>
            Синхронизировать
          </Button>
        }
      >
        {syncState && syncState.state !== "idle" && (
          <div className="sync-status">
            <div className="row">
              <Chip tone={syncState.state === "success" ? "ok" : syncState.state === "error" ? "err" : "info"}>
                {syncState.state}
              </Chip>
              <span className="muted">{syncState.phase}</span>
            </div>
            {syncState.total > 0 && (
              <ProgressBar value={syncState.total === 0 ? 0 : syncState.current / syncState.total} />
            )}
            <div className="faint" style={{ fontSize: "var(--fs-xs)" }}>
              Загружено {syncState.uploaded}, пропущено {syncState.skipped}, удалено {syncState.deleted}
            </div>
            {syncState.error && <div className="text-err" style={{ fontSize: "var(--fs-sm)" }}>{syncState.error}</div>}
          </div>
        )}
        {(!syncState || syncState.state === "idle") && (
          <p className="muted" style={{ fontSize: "var(--fs-sm)" }}>
            Синхронизация ещё не запускалась для этой сборки.
          </p>
        )}
      </Panel>

      <Panel
        title="Проверки"
        description="Целостность файлов и полнота зависимостей модов."
        actions={
          <Button size="sm" icon={<IconRefresh size={14} />} onClick={runChecks}>
            Запустить
          </Button>
        }
      >
        {checks ? (
          <pre className="checks-output mono">{checks}</pre>
        ) : (
          <p className="muted" style={{ fontSize: "var(--fs-sm)" }}>
            Проверка не запускалась.
          </p>
        )}
      </Panel>

      <Panel title="Обслуживание">
        <div className="service-list">
          <div className="service-row">
            <div className="grow">
              <div>Активировать сборку</div>
              <div className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                {build.isActive ? "Сборка уже активна" : "Сделать активной для новых игроков"}
              </div>
            </div>
            {!build.isActive && (
              <Button size="sm" onClick={async () => {
                await api.activateBuild(build.id);
                toast.success("Сборка активирована");
                onChanged();
              }}>
                Активировать
              </Button>
            )}
          </div>
          <div className="service-row">
            <div className="grow">
              <div>Скачать архивом</div>
              <div className="faint" style={{ fontSize: "var(--fs-xs)" }}>Zip всей сборки, собирается на лету</div>
            </div>
            <IconButton
              label="Скачать"
              size="sm"
              onClick={() => void api.downloadFolderArchive(build.id, "")}
            >
              <IconDownload size={14} />
            </IconButton>
          </div>
          <div className="service-row">
            <div className="grow">
              <div>Клонировать</div>
              <div className="faint" style={{ fontSize: "var(--fs-xs)" }}>Полная копия со всеми файлами</div>
            </div>
            <Button size="sm" onClick={async () => {
              const created = await api.cloneBuild(build.id);
              toast.success("Сборка скопирована");
              onChanged();
              onCloned(created);
            }}>
              Клонировать
            </Button>
          </div>
          <div className="service-row">
            <div className="grow">
              <div className="text-err">Удалить сборку</div>
            </div>
            <Button size="sm" variant="danger" onClick={removeBuild}>
              Удалить
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
