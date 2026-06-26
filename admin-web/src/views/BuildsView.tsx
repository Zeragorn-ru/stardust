import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { BuildHeader } from "../types";
import { useConfirm, useToast } from "../ui/feedback";
import { IconPlus, IconStar, IconTrash } from "../ui/icons";
import { BuildDetail } from "../BuildDetail";
import { CreateBuildForm } from "../CreateBuildForm";

export function BuildsView() {
  const toast = useToast();
  const confirm = useConfirm();
  const [builds, setBuilds] = useState<BuildHeader[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.listBuilds();
      setBuilds(list);
      setSelected((cur) => {
        if (cur !== null && list.some((b) => b.id === cur)) return cur;
        const active = list.find((b) => b.isActive);
        return active?.id ?? list[0]?.id ?? null;
      });
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
      title: `Удалить сборку «${name}»?`,
      body: "Будут удалены все её файлы из манифеста. Действие необратимо.",
      confirmText: "Удалить",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteBuild(id);
      if (selected === id) setSelected(null);
      toast.success("Сборка удалена");
      await load();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось удалить сборку",
      );
    }
  }

  return (
    <div className="view builds-layout">
      <div className="builds-aside">
        <header className="view-head compact">
          <h1>Сборки</h1>
          <button className="primary icon-btn" onClick={() => setCreating(true)}>
            <IconPlus /> Создать
          </button>
        </header>
        {loading ? (
          <p className="muted pad">Загрузка…</p>
        ) : builds.length === 0 ? (
          <p className="muted pad">Сборок пока нет. Создайте первую.</p>
        ) : (
          <ul className="build-list">
            {builds.map((b) => (
              <li
                key={b.id}
                className={`build-item${selected === b.id ? " selected" : ""}`}
                onClick={() => setSelected(b.id)}
              >
                <div className="build-item-main">
                  <div className="build-item-title">
                    <strong>{b.name}</strong>
                    {b.isActive && (
                      <span className="badge active">
                        <IconStar size={12} /> активная
                      </span>
                    )}
                  </div>
                  <span className="meta">
                    v{b.version} · {b.loaderKind} · MC {b.mcVersion}
                  </span>
                </div>
                <button
                  className="danger icon-only"
                  title="Удалить сборку"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeBuild(b.id, b.name);
                  }}
                >
                  <IconTrash size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="builds-main">
        {selected !== null ? (
          <BuildDetail buildId={selected} onChanged={load} />
        ) : (
          <div className="empty-state">
            <p className="muted">Выберите сборку слева или создайте новую.</p>
          </div>
        )}
      </div>

      {creating && (
        <CreateBuildForm
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
            load();
          }}
        />
      )}
    </div>
  );
}
