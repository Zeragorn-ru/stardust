import { useEffect, useRef, useState } from "react";
import type { PlayerProfile, Progress, UpdateInfo } from "./types";
import { checkUpdate, closeWindow, currentProfile, gameRunning, logout, onLauncherProgress } from "./api";
import { isOnboarded, setOnboarded } from "./preferences";
import { useSkin } from "./skin";
import Aurora from "./components/Aurora";
import OnboardingScreen from "./components/OnboardingScreen";
import LoginScreen from "./components/LoginScreen";
import MainScreen from "./components/MainScreen";
import SettingsScreen from "./components/SettingsScreen";
import TitleBar from "./components/TitleBar";
import UpdateModal from "./components/UpdateModal";

type View = "onboarding" | "login" | "main" | "settings";
type SettingsSection = "general" | "account";

export default function App() {
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [view, setView] = useState<View>("login");
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");
  const [ready, setReady] = useState(false);
  const { reload: reloadSkin } = useSkin();

  // Обновление, обнаруженное авто-проверкой (показываем всплывашкой).
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  // Состояние запуска — живёт в App, чтобы не сбрасывалось при переходе в настройки.
  const [progress, setProgress] = useState<Progress | null>(null);
  const [running, setRunning] = useState(false);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const runningRef = useRef(running);
  runningRef.current = running;

  const busy =
    running ||
    (progress != null &&
      ["checking", "downloading", "extracting", "launching"].includes(progress.phase));

  // Подписываемся на события прогресса один раз на уровне App.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onLauncherProgress(setProgress).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, []);

  // При старте проверяем, не запущена ли игра уже (переоткрытие лаунчера).
  useEffect(() => {
    gameRunning().then((alive) => {
      if (alive) {
        setRunning(true);
        setProgress({ phase: "running", label: "Игра запущена", fraction: null });
      }
    });
  }, []);

  // Пока игра жива — опрашиваем процесс.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(async () => {
      if (!(await gameRunning())) {
        setRunning(false);
        setProgress(null);
      }
    }, 1500);
    return () => clearInterval(id);
  }, [running]);

  // Escape закрывает окно только если игра не в процессе запуска/работы.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && !runningRef.current && !progressRef.current) {
        void closeWindow();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Стартовый экран + попытка автологина из сохранённой сессии.
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
          // Скин привязан к аккаунту — тянем его с сервера после автологина.
          reloadSkin();
        }
      })
      .finally(() => setReady(true));
  }, []);

  // Проверка обновлений при запуске и затем раз в 30 минут. Ошибки
  // (нет сети, GitHub недоступен) глотаем молча — это не должно мешать
  // запуску и работе лаунчера.
  useEffect(() => {
    let cancelled = false;
    let checking = false;

    async function runCheck() {
      if (checking) return;
      checking = true;
      try {
        const info = await checkUpdate();
        if (!cancelled && info.available) setUpdate(info);
      } catch {
        // ignore
      } finally {
        checking = false;
      }
    }

    runCheck();
    const timer = window.setInterval(runCheck, 30 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  function finishOnboarding() {
    setOnboarded();
    setView("login");
  }

  function handleAuthenticated(p: PlayerProfile) {
    setProfile(p);
    setView("main");
    // Подтянуть скин именно этого аккаунта (у разных аккаунтов разные скины).
    reloadSkin();
  }

  async function handleLogout() {
    await logout();
    setProfile(null);
    setView("login");
    // Сбросить скин, чтобы он не «протёк» на экран следующего игрока.
    reloadSkin();
  }

  function handleAccountDeleted() {
    // Сессия уже удалена бэкендом — просто возвращаемся на экран входа.
    setProfile(null);
    setView("login");
    reloadSkin();
  }

  return (
    <div className="app">
      <Aurora />
      <TitleBar />
      <div className="app__content">
        {!ready ? (
          <div className="app--center">
            <div className="spinner" />
          </div>
        ) : (
          <>
            {/* Экраны без состояния запуска — пересоздаём при переходе для анимации */}
            {(view === "onboarding" || view === "login") && (
              <div key={view} className="screen-enter">
                {view === "onboarding" && (
                  <OnboardingScreen onDone={finishOnboarding} />
                )}
                {view === "login" && (
                  <LoginScreen onAuthenticated={handleAuthenticated} />
                )}
              </div>
            )}
            {/* Main и Settings не пересоздаём — progress живёт в App */}
            {view === "main" && profile && (
              <div className="screen-enter">
                <MainScreen
                  profile={profile}
                  progress={progress}
                  running={running}
                  busy={busy}
                  onProgressChange={setProgress}
                  onRunningChange={setRunning}
                  onOpenSettings={(section) => {
                    setSettingsSection(section ?? "general");
                    setView("settings");
                  }}
                  onLogout={handleLogout}
                />
              </div>
            )}
            {view === "settings" && (
              <div className="screen-enter">
                <SettingsScreen
                  profile={profile}
                  onProfileChange={setProfile}
                  onAccountDeleted={handleAccountDeleted}
                  initialSection={settingsSection}
                  onClose={() => setView("main")}
                />
              </div>
            )}
          </>
        )}
      </div>
      {update && (
        <UpdateModal update={update} onDismiss={() => setUpdate(null)} />
      )}
    </div>
  );
}
