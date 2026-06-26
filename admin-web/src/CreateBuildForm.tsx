import { useEffect, useState } from "react";
import { api, ApiError } from "./api";
import type { CreateBuildInput } from "./types";
import { useToast } from "./ui/feedback";
import { useBodyScrollLock } from "./ui/useBodyScrollLock";

const LOADERS = ["neoforge", "forge", "fabric", "quilt", "vanilla"];

export function CreateBuildForm({
  onCreated,
  onClose,
}: {
  onCreated: (id: number) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  useBodyScrollLock();
  const [form, setForm] = useState<CreateBuildInput>({
    name: "",
    version: "",
    loaderKind: "neoforge",
    mcVersion: "",
    loaderVersion: "",
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal modal-wide"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Новая сборка</h3>
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
          <button type="button" onClick={onClose}>
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
