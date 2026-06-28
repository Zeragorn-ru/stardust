import { useEffect, useRef, useState } from "react";
import type { SkinModel } from "../types";
import { useSkin } from "../skin";
import { importSkinFromLicense } from "../api";
import SkinViewer3D from "./SkinViewer3D";

interface Props {
  onClose: () => void;
  /** Если true — рендерим только body+footer без overlay и header (используется внутри CustomizeModal). */
  embedded?: boolean;
}

type Tab = "file" | "license";

// Стандартный скин Minecraft — 64×64. Файлы 64×32 (старый формат) тоже
// принимаем, но предупреждаем: 3D-модель ждёт 64×64.
const MAX_BYTES = 256 * 1024;

export default function SkinModal({ onClose, embedded = false }: Props) {
  const { skin, save, reload } = useSkin();
  // Если текущий скин импортирован с лицензии — сразу открываем вкладку «С лицензии»
  // с подставленным источником (UUID лицензии).
  const [tab, setTab] = useState<Tab>(skin.source ? "license" : "file");

  // --- Вкладка «Файл» ---
  const [dataUrl, setDataUrl] = useState<string | null>(skin.dataUrl);
  const [model, setModel] = useState<SkinModel>(skin.model);
  const fileRef = useRef<HTMLInputElement>(null);

  // --- Вкладка «Лицензия» ---
  const [source, setSource] = useState(skin.source ?? "");
  const [keepSynced, setKeepSynced] = useState(true);

  // Скин мог ещё не догрузиться к моменту открытия модалки (SkinProvider
  // читает его асинхронно). Когда источник появится — один раз переключаемся
  // на вкладку «С лицензии» и подставляем UUID, не мешая ручному выбору вкладки.
  const autoSwitched = useRef(false);
  useEffect(() => {
    if (autoSwitched.current || !skin.source) return;
    autoSwitched.current = true;
    setTab("license");
    setSource(skin.source);
  }, [skin.source]);

  // --- Общее ---
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Что показываем в превью: для файла — выбранный PNG, для лицензии —
  // текущий скин аккаунта (после импорта он обновится через reload).
  const previewSkin = tab === "file" ? dataUrl : skin.dataUrl;
  const previewCape = tab === "file" ? null : skin.capeUrl;
  const previewModel = tab === "file" ? model : skin.model;

  function pickFile() {
    fileRef.current?.click();
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== "image/png") {
      setError("Скин должен быть в формате PNG");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("Файл слишком большой (макс. 256 КБ)");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      // Проверяем размеры: ожидаем 64×64 (или 64×32).
      const img = new Image();
      img.onload = () => {
        const okWidth = img.width === 64;
        const okHeight = img.height === 64 || img.height === 32;
        if (!okWidth || !okHeight) {
          setError(
            `Ожидается скин 64×64 (получено ${img.width}×${img.height})`,
          );
          return;
        }
        setDataUrl(url);
      };
      img.onerror = () => setError("Не удалось прочитать изображение");
      img.src = url;
    };
    reader.onerror = () => setError("Не удалось прочитать файл");
    reader.readAsDataURL(file);
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      if (tab === "file") {
        if (!dataUrl) {
          setError("Сначала выберите файл скина");
          return;
        }
        await save(dataUrl, model);
        onClose();
      } else {
        await importSkinFromLicense(source, keepSynced);
        // Подтягиваем импортированный скин+плащ с сервера.
        await reload();
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function switchTab(next: Tab) {
    setTab(next);
    setError(null);
  }

  const canClose = !saving;

  const body = (
    <>
        <div className="skin-modal__body">
          <div className="skin-modal__preview">
            <SkinViewer3D
              dataUrl={previewSkin}
              model={previewModel}
              capeUrl={previewCape}
              width={220}
              height={300}
            />
            <p className="muted skin-modal__hint">Покрутите модель мышью</p>
          </div>

          <div className="skin-modal__controls">
            <div className="skin-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "file"}
                className={"skin-tab" + (tab === "file" ? " is-active" : "")}
                onClick={() => switchTab("file")}
              >
                Файл
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "license"}
                className={"skin-tab" + (tab === "license" ? " is-active" : "")}
                onClick={() => switchTab("license")}
              >
                С лицензии
              </button>
              <span
                className={
                  "skin-tabs__ink" + (tab === "license" ? " is-right" : "")
                }
                aria-hidden="true"
              />
            </div>

            {tab === "file" ? (
              <div key="file" className="skin-tab-panel">
                <div className="field">
                  <span>Модель</span>
                  <div className="segmented">
                    <button
                      type="button"
                      className={
                        "segmented__opt" +
                        (model === "classic" ? " is-active" : "")
                      }
                      onClick={() => setModel("classic")}
                    >
                      Classic
                    </button>
                    <button
                      type="button"
                      className={
                        "segmented__opt" +
                        (model === "slim" ? " is-active" : "")
                      }
                      onClick={() => setModel("slim")}
                    >
                      Slim
                    </button>
                  </div>
                </div>

                <button className="btn btn--soft" onClick={pickFile}>
                  Выбрать PNG…
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png"
                  hidden
                  onChange={handleFile}
                />

                <p className="muted skin-modal__note">
                  Формат: PNG 64×64. Поддерживается второй слой (шляпа, куртка).
                </p>
              </div>
            ) : (
              <div key="license" className="skin-tab-panel">
                <label className="field">
                  <span>Ник или UUID лицензии</span>
                  <input
                    type="text"
                    value={source}
                    placeholder="например, Notch"
                    autoFocus
                    onChange={(e) => setSource(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !saving) handleSave();
                    }}
                  />
                </label>

                <label className="skin-sync">
                  <input
                    type="checkbox"
                    checked={keepSynced}
                    onChange={(e) => setKeepSynced(e.target.checked)}
                  />
                  <span>
                    Синхронизируем скин и плащ
                    <span className="muted skin-sync__hint">
                      Лаунчер запомнит UUID лицензии и будет обновлять скин и
                      плащ — даже после смены ника.
                    </span>
                  </span>
                </label>

                <p className="muted skin-modal__note">
                  Импортируем скин и плащ с официального аккаунта Mojang.
                </p>
              </div>
            )}

            {error && <div className="alert alert--error">{error}</div>}
          </div>
        </div>

        <footer className="modal__footer">
          <button className="btn btn--ghost" onClick={canClose ? onClose : undefined} disabled={!canClose}>
            Отмена
          </button>
          <button
            className="btn btn--primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving
              ? tab === "file"
                ? "Сохранение…"
                : "Импорт…"
              : tab === "file"
                ? "Сохранить"
                : "Импортировать"}
          </button>
        </footer>
    </>
  );

  if (embedded) return body;

  return (
    <div className="modal-overlay" onClick={canClose ? onClose : undefined}>
      <div
        className="modal skin-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal__header">
          <h2>Скин</h2>
          <button
            type="button"
            className="btn btn--icon"
            onClick={canClose ? onClose : undefined}
            disabled={!canClose}
            aria-label="Закрыть"
          >
            ✕
          </button>
        </header>
        {body}
      </div>
    </div>
  );
}
