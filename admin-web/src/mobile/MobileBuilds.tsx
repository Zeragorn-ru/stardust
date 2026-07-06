// Список сборок (мобильный): карточки на всю ширину, детали открываются внутри
// mobile shell без смены URL. Создание, клонирование и удаление — здесь же.

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { BuildHeader } from "../types";
import { useConfirm, useToast } from "../ui/feedback";
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
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setBuilds(await api.listBuilds());
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось загрузить сборки",
      );
    } finally {
      setLoading(false);
    }
  }, [toast]);

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
    <div className="m-screen">
      <header className="m-head">
        <div>
          <span className="m-eyebrow">Deployment</span>
          <h1>Сборки</h1>
        </div>
      </header>

      {loading ? (
        <p className="muted pad">
          <span className="spinner" />
          Загрузка…
        </p>
      ) : builds.length === 0 ? (
        <p className="muted pad">Сборок пока нет. Создайте первую.</p>
      ) : (
        <ul className="m-cards">
          {builds.map((b) => (
            <li
              key={b.id}
              className="m-card"
              onClick={() => onOpenBuild(b.id)}
            >
              <div className="m-card-body">
                <div className="m-card-title">
                  <strong>{b.name}</strong>
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
                  disabled={busy === b.id}
                  onClick={() => cloneBuild(b.id, b.name)}
                >
                  <IconCopy size={18} />
                </button>
                <button
                  className="danger icon-only"
                  title="Удалить"
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
