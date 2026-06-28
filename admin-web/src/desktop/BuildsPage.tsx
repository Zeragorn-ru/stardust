// Экран сборок (десктоп): список слева, детали выбранной справа.
//
// Выбранная сборка адресуется маршрутом `/builds/:id`, поэтому ссылка на
// конкретную сборку открывается напрямую, а «назад» возвращает к прежней.
// Добавлена кнопка клонирования: создаёт копию со всеми файлами и сразу
// открывает её.

import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import type { BuildHeader } from "../types";
import { useConfirm, useToast } from "../ui/feedback";
import { IconCopy, IconPlus, IconStar, IconTrash } from "../ui/icons";
import { BuildDetail } from "../BuildDetail";
import { CreateBuildForm } from "../CreateBuildForm";

// Имя сборки по id (для тоста клонирования из шапки деталей).
function buildName(builds: BuildHeader[], id: number): string {
  return builds.find((b) => b.id === id)?.name ?? "сборка";
}

export function BuildsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const params = useParams();
  const selected = params.id ? Number(params.id) : null;

  const [builds, setBuilds] = useState<BuildHeader[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busyClone, setBusyClone] = useState<number | null>(null);

  const select = useCallback(
    (id: number | null) => {
      navigate(id === null ? "/builds" : `/builds/${id}`);
    },
    [navigate],
  );

  const load = useCallback(async () => {
    try {
      const list = await api.listBuilds();
      setBuilds(list);
      // Если URL не указывает на существующую сборку — выбираем активную/первую.
      const validSelection =
        selected !== null && list.some((b) => b.id === selected);
      if (!validSelection) {
        const fallback = list.find((b) => b.isActive)?.id ?? list[0]?.id ?? null;
        if (fallback !== selected) select(fallback);
      }
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось загрузить сборки",
      );
    } finally {
      setLoading(false);
    }
    // selected умышленно вне зависимостей: load вызывается явно, а не на
    // каждое изменение выбора (иначе зациклится с select).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast, select]);

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
      if (selected === id) select(null);
      toast.success("Сборка удалена");
      await load();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось удалить сборку",
      );
    }
  }

  async function cloneBuild(id: number, name: string) {
    setBusyClone(id);
    try {
      const res = await api.cloneBuild(id);
      toast.success(`Создана копия «${name}»`);
      await load();
      select(res.id);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось клонировать сборку",
      );
    } finally {
      setBusyClone(null);
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
          <p className="muted pad">
            <span className="spinner" />
            Загрузка…
          </p>
        ) : builds.length === 0 ? (
          <p className="muted pad">Сборок пока нет. Создайте первую.</p>
        ) : (
          <ul className="build-list">
            {builds.map((b) => (
              <li
                key={b.id}
                className={`build-item${selected === b.id ? " selected" : ""}`}
                onClick={() => select(b.id)}
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
                <div className="build-item-actions">
                  <button
                    className="icon-only"
                    title="Клонировать сборку"
                    disabled={busyClone === b.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      cloneBuild(b.id, b.name);
                    }}
                  >
                    <IconCopy size={15} />
                  </button>
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
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="builds-main">
        {selected !== null ? (
          <BuildDetail
            buildId={selected}
            onChanged={load}
            onClone={(id) => cloneBuild(id, buildName(builds, id))}
          />
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
            load();
            select(id);
          }}
        />
      )}
    </div>
  );
}
