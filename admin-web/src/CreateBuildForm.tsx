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
  // Мягкая валидация: помечаем обязательные поля, из которых «выходили»
  // (blur), — подсказка об обязательности появляется только после этого,
  // а не сразу при открытии формы.
  const [touched, setTouched] = useState({
    name: false,
    version: false,
    mcVersion: false,
  });

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
              onBlur={() => setTouched((t) => ({ ...t, name: true }))}
              autoFocus
              placeholder="Моя сборка"
              aria-invalid={touched.name && !form.name.trim() || undefined}
            />
            {touched.name && !form.name.trim() && (
              <p className="input-error">Заполните название</p>
            )}
          </div>
          <div className="field">
            <label>Версия сборки</label>
            <input
              value={form.version}
              onChange={(e) => set("version", e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, version: true }))}
              placeholder="напр. 1.0.0"
              aria-invalid={touched.version && !form.version.trim() || undefined}
            />
            {touched.version && !form.version.trim() && (
              <p className="input-error">Заполните версию сборки</p>
            )}
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
              onBlur={() => setTouched((t) => ({ ...t, mcVersion: true }))}
              placeholder="напр. 1.21.1"
              aria-invalid={
                touched.mcVersion && !form.mcVersion.trim() || undefined
              }
            />
            {touched.mcVersion && !form.mcVersion.trim() && (
              <p className="input-error">Заполните версию Minecraft</p>
            )}
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
