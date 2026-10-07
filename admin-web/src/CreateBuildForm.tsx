import { useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { CreateBuildInput } from "./types";
import { useToast, useConfirm } from "./ui/feedback";
import { useBodyScrollLock } from "./ui/useBodyScrollLock";
import { useDialogFocus } from "./ui/useDialogFocus";

const LOADERS = ["neoforge", "forge", "fabric", "quilt", "vanilla"];

export function CreateBuildForm({
  onCreated,
  onClose,
}: {
  onCreated: (id: number) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const dialogRef = useRef<HTMLFormElement>(null);
  useBodyScrollLock();
  const [form, setForm] = useState<CreateBuildInput>({
    name: "",
    version: "",
    loaderKind: "neoforge",
    mcVersion: "",
    loaderVersion: "",
  });
  const [busy, setBusy] = useState(false);

  // Dirty в ref: закрытие по подложке/Escape проверяет актуальное значение.
  const dirty =
    Boolean(form.name.trim() || form.version.trim() || form.mcVersion.trim() || form.loaderVersion.trim()) ||
    form.loaderKind !== "neoforge";
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  async function tryClose() {
    if (busyRef.current) return;
    if (dirtyRef.current) {
      const ok = await confirm({
        title: "Есть несохранённые изменения",
        body: "Закрыть форму без создания сборки?",
        confirmText: "Закрыть",
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  }

  useDialogFocus(dialogRef, () => void tryClose());

  function set<K extends keyof CreateBuildInput>(
    key: K,
    value: CreateBuildInput[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.createBuild({
        ...form,
        name: form.name.trim(),
        version: form.version.trim(),
        mcVersion: form.mcVersion.trim(),
        loaderVersion: form.loaderVersion.trim(),
      });
      toast.success("Сборка создана");
      onCreated(res.id);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось создать сборку",
      );
    } finally {
      setBusy(false);
    }
  }

  const valid =
    form.name.trim() && form.version.trim() && form.mcVersion.trim();

  return (
    <div className="modal-backdrop" onClick={() => void tryClose()}>
      <form
        ref={dialogRef}
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-build-title"
        tabIndex={-1}
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="create-build-title">Новая сборка</h3>
        <div className="row">
          <div className="field">
            <label>Название</label>
            <input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              autoFocus
              placeholder="Моя сборка"
            />
          </div>
          <div className="field">
            <label>Версия сборки</label>
            <input
              value={form.version}
              onChange={(e) => set("version", e.target.value)}
              placeholder="1.0.0"
            />
          </div>
        </div>
        <div className="row">
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
              placeholder="1.21.1"
            />
          </div>
          <div className="field">
            <label>Версия загрузчика</label>
            <input
              value={form.loaderVersion}
              onChange={(e) => set("loaderVersion", e.target.value)}
              placeholder="напр. 21.1.72"
            />
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={() => void tryClose()} disabled={busy}>
            Отмена
          </button>
          <button className="primary" type="submit" disabled={busy || !valid}>
            {busy ? "Создание…" : "Создать"}
          </button>
        </div>
      </form>
    </div>
  );
}
