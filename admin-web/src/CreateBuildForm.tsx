import { useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { CreateBuildInput } from "./types";
import { useToast } from "./ui/feedback";
import { useBodyScrollLock } from "./ui/useBodyScrollLock";
import { useDialogFocus } from "./ui/useDialogFocus";
import { useDirtyGuard } from "./ui/useDirtyGuard";
import { Field, FieldInput, fieldTouchedError } from "./ui/Field";
import { LOADERS } from "./ui/buildActions";

export function CreateBuildForm({
  onCreated,
  onClose,
}: {
  onCreated: (id: number) => void;
  onClose: () => void;
}) {
  const toast = useToast();
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

  // Dirty-guard: Escape и клик по подложке спрашивают подтверждение
  // вместо молчаливой потери введённого (общий хук, план 4.4).
  const dirty =
    Boolean(form.name.trim() || form.version.trim() || form.mcVersion.trim() || form.loaderVersion.trim()) ||
    form.loaderKind !== "neoforge";

  const tryClose = useDirtyGuard({
    isDirty: dirty,
    isBusy: busy,
    onClose,
    body: "Закрыть форму без создания сборки?",
  });
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
          <Field
            label="Название"
            error={fieldTouchedError(touched.name, !form.name.trim() ? "Заполните название" : null)}
          >
            {(control) => (
              <FieldInput
                control={control}
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                autoFocus
                placeholder="Моя сборка"
              />
            )}
          </Field>
          <Field
            label="Версия сборки"
            error={fieldTouchedError(touched.version, !form.version.trim() ? "Заполните версию сборки" : null)}
          >
            {(control) => (
              <FieldInput
                control={control}
                value={form.version}
                onChange={(e) => set("version", e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, version: true }))}
                placeholder="напр. 1.0.0"
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
          <Field
            label="Версия Minecraft"
            error={fieldTouchedError(touched.mcVersion, !form.mcVersion.trim() ? "Заполните версию Minecraft" : null)}
          >
            {(control) => (
              <FieldInput
                control={control}
                value={form.mcVersion}
                onChange={(e) => set("mcVersion", e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, mcVersion: true }))}
                placeholder="напр. 1.21.1"
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
            {busy ? "Создание…" : "Создать"}
          </button>
        </div>
      </form>
    </div>
  );
}
