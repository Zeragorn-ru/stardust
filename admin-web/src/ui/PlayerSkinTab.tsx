import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Account, SkinModel } from "../types";
import { invalidateSkinCache } from "./SkinHead";
import { useToast } from "./feedback";

const PlayerSkinViewer3D = lazy(() => import("./PlayerSkinViewer3D"));
const MAX_SKIN_BYTES = 256 * 1024;

interface Props {
  account: Account;
  onUpdated: (account: Account) => void;
}

export function PlayerSkinTab({ account, onUpdated }: Props) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [skin, setSkin] = useState<{ url: string; model: SkinModel } | null>(null);
  const [pending, setPending] = useState<{ file: File; url: string } | null>(null);
  const [model, setModel] = useState<SkinModel>("classic");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api
      .getAccountSkin(account.uuid)
      .then((next) => {
        if (!active) return;
        setSkin(next);
        setModel(next?.model ?? "classic");
      })
      .catch(() => {
        if (active) setError("Не удалось загрузить скин игрока");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [account.uuid]);

  useEffect(() => () => {
    if (pending) URL.revokeObjectURL(pending.url);
  }, [pending]);

  async function chooseFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (file.type !== "image/png") {
      setError("Скин должен быть в формате PNG");
      return;
    }
    if (file.size > MAX_SKIN_BYTES) {
      setError("Файл слишком большой (максимум 256 КБ)");
      return;
    }
    try {
      await validateSkin(file);
      const url = URL.createObjectURL(file);
      setPending((previous) => {
        if (previous) URL.revokeObjectURL(previous.url);
        return { file, url };
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось прочитать PNG");
    }
  }

  async function save() {
    if (!pending) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.setAccountSkin(account.uuid, pending.file, model);
      invalidateSkinCache(account.uuid);
      setSkin(await api.getAccountSkin(account.uuid));
      setPending(null);
      onUpdated(updated);
      toast.success("Скин игрока обновлен");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Не удалось сохранить скин");
    } finally {
      setSaving(false);
    }
  }

  const preview = pending ? { url: pending.url, model } : skin;

  return (
    <div className="pc-skin-tab">
      <div className="pc-skin-stage">
        {loading ? (
          <div className="pc-skin-viewer pc-skin-viewer--fallback"><span className="spinner" /> Загрузка скина…</div>
        ) : preview ? (
          <Suspense fallback={<div className="pc-skin-viewer pc-skin-viewer--fallback">Загрузка 3D-превью…</div>}>
            <PlayerSkinViewer3D src={preview.url} model={preview.model} />
          </Suspense>
        ) : (
          <div className="pc-skin-viewer pc-skin-viewer--fallback">У игрока пока нет скина</div>
        )}
      </div>

      <div className="pc-skin-controls">
        <div>
          <div className="pc-section-title">Модель</div>
          <div className="pc-skin-models">
            {(["classic", "slim"] as const).map((value) => (
              <button
                type="button"
                key={value}
                className={"pc-skin-model" + (model === value ? " active" : "")}
                onClick={() => setModel(value)}
                disabled={saving}
              >
                {value === "classic" ? "Classic" : "Slim"}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="secondary" onClick={() => fileRef.current?.click()} disabled={saving}>
          Выбрать PNG
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png"
          hidden
          onChange={(event) => {
            void chooseFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <p className="muted pc-skin-note">PNG 64x64 или 64x32, до 256 КБ. Изменение удаляет импортированный плащ и синхронизацию с Mojang.</p>
        {error && <div className="error">{error}</div>}
        {pending && (
          <button type="button" className="primary" onClick={save} disabled={saving}>
            {saving ? "Сохранение…" : "Сохранить скин"}
          </button>
        )}
      </div>
    </div>
  );
}

function validateSkin(file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      if (image.width === 64 && (image.height === 64 || image.height === 32)) {
        resolve();
      } else {
        reject(new Error(`Ожидается скин 64x64 или 64x32 (получено ${image.width}x${image.height})`));
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Не удалось прочитать PNG"));
    };
    image.src = url;
  });
}
