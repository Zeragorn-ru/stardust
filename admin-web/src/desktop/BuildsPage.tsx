// Экран сборок (десктоп): список сборок перенесен в левый сайдбар всего приложения,
// здесь отображаются детали выбранной сборки и менеджер файлов.

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { useToast } from "../ui/feedback";
import { IconBox, IconPlus, IconStar } from "../ui/icons";
import { BuildDetail } from "../BuildDetail";
import { CreateBuildForm } from "../CreateBuildForm";
import type { BuildHeader } from "../types";

export function BuildsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const params = useParams();
  const selected = params.id && params.id !== "new" ? Number(params.id) : null;
  const creating = params.id === "new";

  const [loading, setLoading] = useState(true);
  const [builds, setBuilds] = useState<BuildHeader[]>([]);

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
      // Если URL указывает на несуществующую сборку — возвращаем в хаб сборок.
      const validSelection =
        selected !== null && list.some((b) => b.id === selected);
      if (selected !== null && !validSelection && !creating) {
        select(null);
      }
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось загрузить сборки",
      );
    } finally {
      setLoading(false);
    }
  }, [selected, creating, select, toast]);

  useEffect(() => {
    load();
    window.addEventListener("builds-updated", load);
    return () => window.removeEventListener("builds-updated", load);
  }, [load]);

  if (loading) {
    return (
      <div className="view muted pad">
        <span className="spinner" />
        Загрузка…
      </div>
    );
  }

  return (
    <div className="view builds-layout-compact">
      <div className="builds-main-full">
        {selected !== null ? (
          <BuildDetail
            buildId={selected}
            onChanged={load}
          />
        ) : (
          <BuildsHub builds={builds} onCreate={() => navigate("/builds/new")} />
        )}
      </div>

      {creating && (
        <CreateBuildForm
          onClose={() => navigate("/builds")}
          onCreated={(id) => {
            window.dispatchEvent(new Event("builds-updated"));
            navigate(`/builds/${id}`);
          }}
        />
      )}
    </div>
  );
}

function BuildsHub({ builds, onCreate }: { builds: BuildHeader[]; onCreate: () => void }) {
  const active = builds.find((b) => b.isActive);
  return (
    <div className="builds-hub">
      <header className="view-head page-head">
        <div>
          <span className="eyebrow">Modpack pipeline</span>
          <h1>Сборки</h1>
          <p className="muted">
            {builds.length} сборок · {active ? `активна «${active.name}»` : "активная сборка не выбрана"}
          </p>
        </div>
        <button className="primary" onClick={onCreate}>
          <IconPlus size={15} /> Создать сборку
        </button>
      </header>

      {builds.length === 0 ? (
        <div className="empty-state empty-state-redesigned">
          <IconBox size={34} />
          <strong>Сборок пока нет</strong>
          <p>Создайте первую сборку, загрузите файлы и активируйте её для лаунчера.</p>
          <button className="primary" onClick={onCreate}>
            <IconPlus size={15} /> Создать сборку
          </button>
        </div>
      ) : (
        <div className="build-card-grid">
          {builds.map((build) => (
            <Link key={build.id} className={`build-card${build.isActive ? " build-card--active" : ""}`} to={`/builds/${build.id}`}>
              <div className="build-card-orb"><IconBox size={18} /></div>
              <div className="build-card-main">
                <div className="build-card-title">
                  <strong>{build.name}</strong>
                  {build.isActive && <span className="badge active"><IconStar size={11} /> active</span>}
                </div>
                <span className="muted">v{build.version}</span>
              </div>
              <div className="build-card-meta">
                <span>{build.loaderKind}</span>
                <span>MC {build.mcVersion}</span>
                {build.loaderVersion && <span>{build.loaderVersion}</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
