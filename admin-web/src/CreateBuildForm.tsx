import { useState } from "react";
import { api, ApiError } from "./api";
import type { CreateBuildInput } from "./types";

const LOADERS = ["neoforge", "forge", "fabric", "quilt", "vanilla"];

export function CreateBuildForm({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState<CreateBuildInput>({
    name: "",
    version: "",
    loaderKind: "neoforge",
    mcVersion: "",
    loaderVersion: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function set<K extends keyof CreateBuildInput>(key: K, value: CreateBuildInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.createBuild({
        ...form,
        name: form.name.trim(),
        version: form.version.trim(),
        mcVersion: form.mcVersion.trim(),
        loaderVersion: form.loaderVersion.trim(),
      });
      setForm({
        name: "",
        version: "",
        loaderKind: "neoforge",
        mcVersion: "",
        loaderVersion: "",
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось создать сборку");
    } finally {
      setBusy(false);
    }
  }

  const valid = form.name.trim() && form.version.trim() && form.mcVersion.trim();

  return (
    <form className="panel" onSubmit={submit}>
      <h2>Новая сборка</h2>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <div className="field">
          <label>Название</label>
          <input value={form.name} onChange={(e) => set("name", e.target.value)} />
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
      <button className="primary" type="submit" disabled={busy || !valid}>
        {busy ? "Создание…" : "Создать"}
      </button>
    </form>
  );
}
