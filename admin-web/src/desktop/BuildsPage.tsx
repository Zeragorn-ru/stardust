// Экран сборок (десктоп): список сборок перенесен в левый сайдбар всего приложения,
// здесь отображаются детали выбранной сборки и менеджер файлов.

import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { useToast } from "../ui/feedback";
import { IconPlus } from "../ui/icons";
import { BuildDetail } from "../BuildDetail";
import { CreateBuildForm } from "../CreateBuildForm";

export function BuildsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const params = useParams();
  const selected = params.id && params.id !== "new" ? Number(params.id) : null;
  const creating = params.id === "new";

  const [loading, setLoading] = useState(true);

  const select = useCallback(
    (id: number | null) => {
      navigate(id === null ? "/builds" : `/builds/${id}`);
    },
    [navigate],
  );

  const load = useCallback(async () => {
    try {
      const list = await api.listBuilds();
      // Если URL не указывает на существующую сборку — выбираем активную/первую.
      const validSelection =
        selected !== null && list.some((b) => b.id === selected);
      if (!validSelection && !creating) {
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
          <div className="empty-state">
            <p className="muted">Сборок пока нет или выберите сборку в меню слева.</p>
            <button className="primary" onClick={() => navigate("/builds/new")} style={{ marginTop: 12 }}>
              <IconPlus size={14} /> Создать сборку
            </button>
          </div>
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
