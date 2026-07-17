import { useCallback, useEffect, useRef, useState } from "react";
import type { PlayerProfile, Progress, UpdateInfo } from "./types";
import { checkUpdate, closeWindow, currentProfile, gameRunning, logout, onLauncherProgress } from "./api";
import { animationsEnabled, isOnboarded, setOnboarded } from "./preferences";
import { isMac, isModKey } from "./platform";
import { useSkin } from "./skin";
import Aurora from "./components/Aurora";
import ErrorBoundary from "./components/ErrorBoundary";
import OnboardingScreen from "./components/OnboardingScreen";
import LoginScreen from "./components/LoginScreen";
import MainScreen from "./components/MainScreen";
import SettingsScreen from "./components/SettingsScreen";
import TitleBar from "./components/TitleBar";
import UpdateModal from "./components/UpdateModal";

type View = "onboarding" | "login" | "main" | "settings";
type SettingsSection = "general" | "account" | "logs";

const VIEW_ORDER: View[] = ["onboarding", "login", "main", "settings"];
const TRANSITION_MS = 380;

/** Открыт ли оверлей/модалка, которой положено самой обработать Escape. */
function hasOpenOverlay(): boolean {
  return Boolean(
    document.querySelector(
      '.modal-overlay, .update-overlay, [aria-modal="true"]',
    ),
  );
}

export default function App() {
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [view, setView] = useState<View>("login");
  const [exitView, setExitView] = useState<View | null>(null);
  const [exitClass, setExitClass] = useState("");
  const [enterClass, setEnterClass] = useState("screen-enter");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [ready, setReady] = useState(false);
  const { reload: reloadSkin } = useSkin();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const runningRef = useRef(running);
  runningRef.current = running;
  const viewRef = useRef(view);
  viewRef.current = view;
  const navigatingRef = useRef(false);
  const mac = isMac();

  const navigateRef = useRef<((next: View) => void) | null>(null);
  navigateRef.current = navigate;
  const busy =
    running ||
    (progress != null &&
      ["checking", "downloading", "extracting", "launching"].includes(progress.phase));

  function navigate(next: View) {
    if (navigatingRef.current || next === view) return;
    navigatingRef.current = true;

    // Без анимаций — мгновенное переключение без наложения экранов.
    if (!animationsEnabled()) {
      setExitView(null);
      setExitClass("");
      setEnterClass("");
      setView(next);
      navigatingRef.current = false;
      return;
    }

    const fromIdx = VIEW_ORDER.indexOf(view);
    const toIdx = VIEW_ORDER.indexOf(next);
    const forward = toIdx > fromIdx;
    // Горизонтальный слайд для main↔settings, вертикальный для остальных
    const horizontal = (view === "main" || view === "settings") && (next === "main" || next === "settings");
    const exitCls = horizontal
      ? (forward ? "screen-exit-left" : "screen-exit-right")
      : (forward ? "screen-exit-up" : "screen-exit-down");
    const enterCls = horizontal
      ? (forward ? "screen-enter-right" : "screen-enter-left")
      : (forward ? "screen-enter-bottom" : "screen-enter-top");
    setExitView(view);
    setExitClass(exitCls);
    setEnterClass(enterCls);
    setView(next);
    setTimeout(() => {
      setExitView(null);
      setExitClass("");
      navigatingRef.current = false;
    }, TRANSITION_MS);
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onLauncherProgress((p) => {
      setProgress(p);
      if (p.phase === "error") {
        setRunning(false);
      }
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    gameRunning().then((alive) => {
      if (alive) {
        setRunning(true);
        setProgress({ phase: "running", label: "Игра запущена", fraction: null });
      }
    });
  }, []);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(async () => {
      if (!(await gameRunning())) {
        setRunning(false);
        if (progressRef.current?.phase !== "error") {
          setProgress(null);
        }
      }
    }, 1500);
    return () => clearInterval(id);
  }, [running]);

  useEffect(() => {
    if (mac) {
      document.documentElement.dataset.platform = "macos";
    }
  }, [mac]);

  const handleCloseSettings = useCallback(() => {
    navigateRef.current?.("main");
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Cmd/Ctrl+W — закрыть окно (нативный жест macOS / Windows).
      if (isModKey(e) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (!runningRef.current) {
          void closeWindow();
        }
        return;
      }

      if (e.key !== "Escape") return;

      // Модалки / настройки сами обрабатывают Escape.
      if (hasOpenOverlay() || updateModal.visible || viewRef.current === "settings") {
        return;
      }

      // На macOS Escape не закрывает окно — только Cmd+W / меню «Закрыть».
      if (mac) return;

      if (!runningRef.current && !progressRef.current) {
        void closeWindow();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mac, updateModal.visible]);

  useEffect(() => {
    if (!isOnboarded()) {
      setView("onboarding");
      setReady(true);
      return;
    }
    currentProfile()
      .then((p) => {
        if (p) {
          setProfile(p);
          setView("main");
          reloadSkin();
        }
      })
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let checking = false;
    async function runCheck() {
      if (checking) return;
      checking = true;
      try {
        const info = await checkUpdate();
        if (!cancelled && info.available) setUpdate(info);
      } catch { /* ignore */ } finally { checking = false; }
    }
    runCheck();
    const timer = window.setInterval(runCheck, 30 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  function finishOnboarding() { setOnboarded(); navigate("login"); }

  function handleAuthenticated(p: PlayerProfile) {
    setProfile(p);
    navigate("main");
    reloadSkin();
  }

  async function handleLogout() {
    await logout();
    setProfile(null);
    setRunning(false);
    setProgress(null);
    navigate("login");
    reloadSkin();
  }

  function handleAccountDeleted() {
    setProfile(null);
    setRunning(false);
    setProgress(null);
    navigate("login");
    reloadSkin();
  }

  const handleOpenSettings = useCallback((section?: SettingsSection) => {
    setSettingsSection(section ?? "general");
    navigateRef.current?.("settings");
  }, []);

  function renderScreen(v: View, cls: string, key: string) {
    return (
      <div key={key} className={cls}>
        {v === "onboarding" && <OnboardingScreen onDone={finishOnboarding} />}
        {v === "login" && <LoginScreen onAuthenticated={handleAuthenticated} />}
        {v === "main" && profile && (
          <MainScreen
            profile={profile}
            progress={progress}
            running={running}
            busy={busy}
            onProgressChange={setProgress}
            onRunningChange={setRunning}
            onOpenSettings={handleOpenSettings}
            onLogout={handleLogout}
          />
        )}
        {v === "settings" && (
          <SettingsScreen
            profile={profile}
            onProfileChange={setProfile}
            onAccountDeleted={handleAccountDeleted}
            initialSection={settingsSection}
            onClose={handleCloseSettings}
          />
        )}
      </div>
    );
  }

  return (
    <div className={"app" + (mac ? " app--macos" : "")}>
      <Aurora />
      {/* На macOS — нативные traffic lights (Overlay), кастомный бар не нужен. */}
      {!mac && <TitleBar />}
      {mac && (
        <div className="titlebar titlebar--macos-drag" data-tauri-drag-region aria-hidden />
      )}
      <ErrorBoundary>
        <div className="app__content">
          {!ready ? (
            <div className="app--center">
              <div className="spinner" />
            </div>
          ) : (
            <>
              {exitView && renderScreen(exitView, `screen-transition ${exitClass}`, `exit-${exitView}`)}
              {renderScreen(view, `screen-transition ${enterClass}`, `enter-${view}`)}
            </>
          )}
        </div>
      </ErrorBoundary>
      {update && (
        <UpdateModal update={update} onDismiss={() => setUpdate(null)} />
      )}
    </div>
  );
}
