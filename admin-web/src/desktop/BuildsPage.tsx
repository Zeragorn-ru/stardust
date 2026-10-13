// Экран сборок (десктоп): пока сборка не выбрана — хаб со списком карточек,
// иначе — детали выбранной сборки и менеджер файлов.

import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { useConfirm, useToast } from "../ui/feedback";
import { useContextMenu } from "../ui/ContextMenu";
import { activateBuildFromList } from "../ui/buildActions";
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
            key={selected}
            buildId={selected}
            onChanged={load}
          />
        ) : (
          <BuildsHub
            builds={builds}
            onCreate={() => navigate("/builds/new")}
            onActivated={() => void load()}
          />
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

function BuildsHub({
  builds,
  onCreate,
  onActivated,
}: {
  builds: BuildHeader[];
  onCreate: () => void;
  onActivated: () => void;
}) {
  const active = builds.find((b) => b.isActive);
  return (
    <div className="builds-hub">
      {/* Третий уровень заголовков упразднён (план 2.5): топбар уже
          показывает «Сборки» + описание раздела, поэтому хаб ограничивается
          счётчиком и кнопкой создания — eyebrow и subtitle дублировали
          topbar. */}
      <header className="view-head page-head">
        <p className="muted">
          {builds.length} сборок · {active ? `активна «${active.name}»` : "активная сборка не выбрана"}
        </p>
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
            <BuildCard
              key={build.id}
              build={build}
              onActivated={onActivated}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BuildCard({
  build,
  onActivated,
}: {
  build: BuildHeader;
  onActivated: () => void;
}) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const toast = useToast();
  const menu = useContextMenu();

  // «Сделать активной» в контекстном меню карточки (план 3.2): раньше
  // вход в активацию был только через детали сборки.
  function openMenu(e: React.MouseEvent) {
    menu(e, {
      title: build.name,
      items: [
        {
          label: "Открыть",
          onSelect: () => navigate(`/builds/${build.id}`),
        },
        {
          label: "Сделать активной",
          disabled: build.isActive,
          icon: <IconStar size={14} />,
          onSelect: () => {
            void activateBuildFromList(
              build.id,
              build.name,
              confirm,
              toast,
              { version: build.version },
            ).then((ok) => {
              if (ok) onActivated();
            });
          },
        },
      ],
    });
  }

  return (
    // Вся карточка — ссылка (клавиатура/Enter работают нативно через <a>);
    // правый клик открывает контекстное меню с активацией.
    <Link
      className={`build-card${build.isActive ? " build-card--active" : ""}`}
      to={`/builds/${build.id}`}
      aria-label={`Открыть сборку ${build.name}`}
      onContextMenu={openMenu}
    >
      <div className="build-card-orb"><IconBox size={18} /></div>
      <div className="build-card-main">
        <div className="build-card-title">
          <strong>{build.name}</strong>
          {/* Бейдж активной сборки — она отдаётся лаунчеру клиентам. */}
          {build.isActive && (
            <span className="badge active" title="сборка отдаётся лаунчеру">
              <IconStar size={11} /> активная
            </span>
          )}
        </div>
        <span className="muted">v{build.version}</span>
      </div>
      <div className="build-card-meta">
        <span>{build.loaderKind}</span>
        <span>MC {build.mcVersion}</span>
        {build.loaderVersion && <span>{build.loaderVersion}</span>}
      </div>
    </Link>
  );
}
