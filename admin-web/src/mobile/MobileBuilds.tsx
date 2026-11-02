// Список сборок (мобильный): карточки на всю ширину, детали открываются внутри
// mobile shell без смены URL. Создание, клонирование и удаление — здесь же.

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { BuildHeader } from "../types";
import { useConfirm, useToast } from "../ui/feedback";
import { McText } from "../ui/McText";
import { CreateBuildForm } from "../CreateBuildForm";
import {
  IconChevronRight,
  IconCopy,
  IconPlus,
  IconStar,
  IconTrash,
} from "../ui/icons";

type MobileBuildsProps = {
  onOpenBuild: (buildId: number) => void;
};

export function MobileBuilds({ onOpenBuild }: MobileBuildsProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const [builds, setBuilds] = useState<BuildHeader[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBuilds(await api.listBuilds());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Не удалось загрузить сборки");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function removeBuild(id: number, name: string) {
    const ok = await confirm({
      title: `Удалить «${name}»?`,
      body: "Будут удалены все её файлы. Действие необратимо.",
      confirmText: "Удалить",
      danger: true,
    });
    if (!ok) return;
    setBusy(id);
    try {
      await api.deleteBuild(id);
      toast.success("Сборка удалена");
      await load();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось удалить сборку",
      );
    } finally {
      setBusy(null);
    }
  }

  async function cloneBuild(id: number, name: string) {
    setBusy(id);
    try {
      const res = await api.cloneBuild(id);
      toast.success(`Создана копия «${name}»`);
      onOpenBuild(res.id);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось клонировать сборку",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="m-screen m-screen--fab">
      <header className="m-head">
        <div>
          <span className="m-eyebrow">Деплой</span>
          <h1>Сборки</h1>
        </div>
      </header>

      {loading ? (
        <p className="muted pad">
          <span className="spinner" />
          Загрузка…
        </p>
      ) : loadError ? (
        <div className="pad" role="alert">
          <strong>Не удалось загрузить сборки</strong>
          <p>{loadError}</p>
          <button onClick={() => void load()}>Повторить</button>
        </div>
      ) : builds.length === 0 ? (
        <p className="muted pad">Сборок пока нет. Создайте первую.</p>
      ) : (
        <ul className="m-cards">
          {builds.map((b) => (
            <li
              key={b.id}
              className="m-card"
              role="button"
              tabIndex={0}
              aria-label={`Открыть сборку ${b.name}`}
              onClick={() => onOpenBuild(b.id)}
              onKeyDown={(event) => {
                if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  onOpenBuild(b.id);
                }
              }}
            >
              <div className="m-card-body">
                <div className="m-card-title">
                  <strong><McText text={b.name} /></strong>
                  {b.isActive && (
                    <span className="badge active">
                      <IconStar size={12} /> активная
                    </span>
                  )}
                </div>
                <span className="meta muted">
                  v{b.version} · {b.loaderKind} · MC {b.mcVersion}
                </span>
              </div>
              <div className="m-card-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="icon-only"
                  title="Клонировать"
                  aria-label={`Клонировать сборку ${b.name}`}
                  disabled={busy === b.id}
                  onClick={() => cloneBuild(b.id, b.name)}
                >
                  <IconCopy size={18} />
                </button>
                <button
                  className="danger icon-only"
                  title="Удалить"
                  aria-label={`Удалить сборку ${b.name}`}
                  disabled={busy === b.id}
                  onClick={() => removeBuild(b.id, b.name)}
                >
                  <IconTrash size={18} />
                </button>
                <IconChevronRight size={18} className="m-card-chevron" />
              </div>
            </li>
          ))}
        </ul>
      )}

      <button
        className="m-fab"
        title="Создать сборку"
        onClick={() => setCreating(true)}
      >
        <IconPlus size={24} />
      </button>

      {creating && (
        <CreateBuildForm
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            onOpenBuild(id);
          }}
        />
      )}
    </div>
  );
}
