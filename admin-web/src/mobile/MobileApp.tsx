// Мобильная оболочка админки (/m): один web-app экран с выдвижной левой
// навигацией. Вкладки синхронизируются с query-параметрами, чтобы работали
// обновление страницы и кнопки Back/Forward. Записи истории, созданные
// открытием деталей сборки, помечены флагом в history.state: закрытие
// деталей уходит назад по истории, и системный Back не реоткрывает
// закрытую сборку.

import { useEffect, useRef, useState } from "react";
import { FeedbackProvider } from "../ui/feedback";
import { ContextMenuProvider } from "../ui/ContextMenu";
import { AuthProvider, useAuth } from "../app/useAuth";
import { MobileLogin } from "./MobileLogin";
import { MobileOverview } from "./MobileOverview";
import { MobileBuilds } from "./MobileBuilds";
import { MobileBuildDetail } from "./MobileBuildDetail";
import { MobileAccounts } from "./MobileAccounts";
import { MobileSettings } from "./MobileSettings";
import { MobileCustomization } from "./MobileCustomization";
import { MobileSeasons } from "./MobileSeasons";
import { NewsView } from "../views/NewsView";
import { GuidesView } from "../views/GuidesView";
import { LogsView } from "../views/LogsView";
import { ExternalModsView } from "../views/ExternalModsView";
import { IconArrowLeft, IconClose, IconLogout } from "../ui/icons";
import { NAV, NAV_GROUPS, isNavTab, type NavTab } from "../ui/navConfig";
import { switchViewHref } from "../app/viewMode";
import { useDialogFocus } from "../ui/useDialogFocus";

export function MobileApp() {
  return (
    <FeedbackProvider>
      <ContextMenuProvider>
        <AuthProvider>
          <Gate />
        </AuthProvider>
      </ContextMenuProvider>
    </FeedbackProvider>
  );
}

function Gate() {
  const { authed, onLoggedIn } = useAuth();

  if (authed === null) {
    return (
      <div className="login-wrap muted">
        <span className="spinner" />
        Проверка сессии…
      </div>
    );
  }

  if (!authed) return <MobileLogin onLoggedIn={onLoggedIn} />;

  return <Shell />;
}

// Вкладки берутся из единой таблицы навигации (ui/navConfig) — имена,
// иконки и группы совпадают с десктопным сайдбаром и топбаром по
// построению. Декоративные английские eyebrow над заголовком шапки
// («Dashboard», «Deployment»…) убраны: группа раздела остаётся только
// в drawer, где она выполняет роль рубрикатора.
type MobileTab = NavTab;

function Shell() {
  const { username, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<MobileTab>(() => readMobileLocation().tab);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedBuildId, setSelectedBuildId] = useState<number | null>(() => readMobileLocation().buildId);
  const drawerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const activeItem = NAV.find((item) => item.tab === activeTab) ?? NAV[0];
  const activeGroup = selectedBuildId ? null : activeItem.group;

  useEffect(() => {
    if (!drawerOpen) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (drawerRef.current) drawerRef.current.inert = !drawerOpen;
  }, [drawerOpen]);

  // Фокус-ловушка drawer — общий useDialogFocus (план 5, шаг 8): фокус в
  // первый пункт навигации при открытии и возврат на кнопку-гамбургер при
  // закрытии (на iOS тап кнопку не фокусирует — возврат задаём ref'ом).
  // Вызов объявлен ПОСЛЕ эффекта inert: эффекты срабатывают в порядке
  // объявления, и к моменту установки фокуса drawer уже не inert — иначе
  // браузер игнорировал бы focus() на inert-узле.
  useDialogFocus(drawerRef, () => setDrawerOpen(false), {
    active: drawerOpen,
    focusSelector: ".m-drawer-item",
    returnFocus: menuButtonRef,
  });

  useEffect(() => {
    function onPopState() {
      const location = readMobileLocation();
      setActiveTab(location.tab);
      setSelectedBuildId(location.buildId);
      setDrawerOpen(false);
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function openTab(tab: MobileTab) {
    setActiveTab(tab);
    setSelectedBuildId(null);
    setDrawerOpen(false);
    writeMobileLocation(tab, null);
  }

  function openBuild(buildId: number) {
    setActiveTab("builds");
    setSelectedBuildId(buildId);
    setDrawerOpen(false);
    // Флаг в history.state: запись о деталях создана openBuild, и её можно
    // закрыть системной кнопкой Back (history.back), не плодя дублей.
    writeMobileLocation("builds", buildId, true);
  }

  function closeBuild() {
    setSelectedBuildId(null);
    // Если текущая запись создана openBuild — уходим назад по истории, а не
    // pushState(?tab=builds): раньше системный Back реоткрывал закрытую
    // сборку («закрыл → Back → снова открылось»). Для чужих записей
    // (прямая ссылка на сборку) — обычная замена на список.
    if (readBuildHistoryFlag()) {
      window.history.back();
    } else {
      writeMobileLocation("builds", null);
    }
  }

  return (
    <div className="m-app">
      <header className="m-shell-head">
        <button
          className="m-menu-button"
          type="button"
          ref={menuButtonRef}
          aria-label="Открыть меню"
          aria-expanded={drawerOpen}
          aria-controls="mobile-drawer"
          onClick={() => setDrawerOpen(true)}
        >
          <span />
          <span />
          <span />
        </button>
        <div className="m-shell-title">
          <span>{activeGroup ?? "Платформа"}</span>
          <strong>{selectedBuildId ? "Детали сборки" : activeItem.label}</strong>
        </div>
        <div className="m-shell-actions">
          {/* Кнопка «назад» из деталей сборки — прямо в липкой шапке: раньше
              она жила в прокручиваемом контенте и уезжала при прокрутке. */}
          {selectedBuildId && (
            <button
              className="icon-only m-shell-back"
              type="button"
              title="К списку сборок"
              aria-label="К списку сборок"
              onClick={closeBuild}
            >
              <IconArrowLeft size={20} />
            </button>
          )}
          <a className="m-shell-link" href={switchViewHref("desktop")}>ПК-версия</a>
        </div>
      </header>

      {drawerOpen && <button className="m-drawer-scrim" aria-label="Закрыть меню" onClick={() => setDrawerOpen(false)} />}
      <aside
        id="mobile-drawer"
        ref={drawerRef}
        className={`m-drawer${drawerOpen ? " open" : ""}`}
        aria-hidden={!drawerOpen}
        aria-label="Навигация админки"
      >
        <div className="m-drawer-brand">
          <span className="m-brand-mark"><span /></span>
          <div>
            <strong>StarDust</strong>
            <small>Панель управления</small>
          </div>
          <button className="icon-only m-drawer-close" type="button" aria-label="Закрыть меню" onClick={() => setDrawerOpen(false)}>
            <IconClose size={18} />
          </button>
        </div>
        <nav className="m-drawer-nav">
          {NAV_GROUPS.map((group) => (
            <section key={group} aria-label={group}>
              <span className="m-drawer-group">{group}</span>
              {NAV.filter((item) => item.group === group).map((item) => (
                <button
                  key={item.tab}
                  className={`m-drawer-item${activeTab === item.tab ? " active" : ""}`}
                  type="button"
                  onClick={() => openTab(item.tab)}
                >
                  {item.icon(18)}
                  <span>{item.label}</span>
                </button>
              ))}
            </section>
          ))}
        </nav>
        <div className="m-drawer-foot">
          {username && <span className="m-drawer-user">{username}</span>}
          <a className="m-drawer-item" href={switchViewHref("desktop")}>ПК-версия</a>
          <button className="m-drawer-item" type="button" onClick={logout}>
            <IconLogout size={18} />
            <span>Выйти</span>
          </button>
        </div>
      </aside>

      <main className="m-content">
        {activeTab === "overview" && <MobileOverview onOpenTab={openTab} onOpenBuild={openBuild} />}
        {activeTab === "builds" && selectedBuildId == null && <MobileBuilds onOpenBuild={openBuild} />}
        {activeTab === "builds" && selectedBuildId != null && (
          <MobileBuildDetail
            key={selectedBuildId}
            buildId={selectedBuildId}
            onBack={closeBuild}
            onOpenBuild={openBuild}
          />
        )}
        {activeTab === "accounts" && <MobileAccounts />}
        {activeTab === "customization" && <MobileCustomization />}
        {activeTab === "news" && <div className="m-screen"><NewsView mobile /></div>}
        {activeTab === "guides" && <div className="m-screen"><GuidesView mobile /></div>}
        {activeTab === "logs" && <div className="m-screen"><LogsView mobile /></div>}
        {activeTab === "mods" && <div className="m-screen"><ExternalModsView mobile /></div>}
        {activeTab === "seasons" && <MobileSeasons />}
        {activeTab === "settings" && <MobileSettings />}
      </main>
    </div>
  );
}

function readMobileLocation(): { tab: MobileTab; buildId: number | null } {
  const params = new URLSearchParams(window.location.search);
  const rawTab = params.get("tab");
  const tab: MobileTab = rawTab !== null && isNavTab(rawTab) ? rawTab : "overview";
  const rawBuild = params.get("build");
  const buildId = tab === "builds" && rawBuild && /^\d+$/.test(rawBuild) ? Number(rawBuild) : null;
  return { tab, buildId };
}

function writeMobileLocation(tab: MobileTab, buildId: number | null, fromOpenBuild = false) {
  const params = new URLSearchParams();
  if (tab !== "overview") params.set("tab", tab);
  if (buildId != null) params.set("build", String(buildId));
  const query = params.toString();
  // state.mBuildEntry помечает записи, созданные открытием деталей сборки:
  // closeBuild по флагу закрывает их history.back() (план 5, шаг 8).
  window.history.pushState(
    fromOpenBuild ? { mBuildEntry: true } : null,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}`,
  );
}

/** Создана ли текущая запись истории открытием деталей сборки. */
function readBuildHistoryFlag(): boolean {
  return window.history.state?.mBuildEntry === true;
}
