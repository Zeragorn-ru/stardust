import { useState } from "react";
import { api, ApiError } from "./api";
import type { UploadMeta } from "./types";

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

export function FileUpload({
  buildId,
  onUploaded,
}: {
  buildId: number;
  onUploaded: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState("mod");
  const [side, setSide] = useState("both");
  const [path, setPath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [overwrite, setOverwrite] = useState(true);
  const [optional, setOptional] = useState(false);
  const [enabledByDefault, setEnabledByDefault] = useState(true);
  const [modId, setModId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pickFile(f: File | null) {
    setFile(f);
    if (f && !pathEdited) {
      setPath(defaultDir(kind) + f.name);
    }
  }

  function changeKind(k: string) {
    setKind(k);
    if (file && !pathEdited) {
      setPath(defaultDir(k) + file.name);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const meta: UploadMeta = {
        path: path.trim(),
        kind,
        side,
        overwrite,
        optional,
        enabledByDefault,
        modId: optional && modId.trim() ? modId.trim() : undefined,
        displayName: displayName.trim() || undefined,
      };
      await api.uploadFile(buildId, file, meta);
      setFile(null);
      setPath("");
      setPathEdited(false);
      setModId("");
      setDisplayName("");
      onUploaded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить файл");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h2>Загрузить файл</h2>
      {error && <div className="error">{error}</div>}
      <div className="field">
        <label>Файл</label>
        <input
          type="file"
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />
      </div>
      <div className="row">
        <div className="field">
          <label>Тип</label>
          <select value={kind} onChange={(e) => changeKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Сторона</label>
          <select value={side} onChange={(e) => setSide(e.target.value)}>
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
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setPathEdited(true);
          }}
          placeholder="mods/sodium.jar"
        />
      </div>
      <div className="row">
        <div className="field checkbox-row">
          <input
            id="ow"
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
          />
          <label htmlFor="ow">Перезаписывать</label>
        </div>
        <div className="field checkbox-row">
          <input
            id="opt"
            type="checkbox"
            checked={optional}
            onChange={(e) => setOptional(e.target.checked)}
          />
          <label htmlFor="opt">Опциональный</label>
        </div>
        {optional && (
          <div className="field checkbox-row">
            <input
              id="ebd"
              type="checkbox"
              checked={enabledByDefault}
              onChange={(e) => setEnabledByDefault(e.target.checked)}
            />
            <label htmlFor="ebd">Включён по умолчанию</label>
          </div>
        )}
      </div>
      {optional && (
        <div className="row">
          <div className="field">
            <label>mod id (для запоминания выбора игрока)</label>
            <input value={modId} onChange={(e) => setModId(e.target.value)} />
          </div>
          <div className="field">
            <label>Отображаемое имя</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
        </div>
      )}
      <button
        className="primary"
        type="submit"
        disabled={busy || !file || !path.trim()}
      >
        {busy ? "Загрузка…" : "Загрузить"}
      </button>
    </form>
  );
}
