import { useEffect, useState } from "react";
import type { PlayerProfile } from "./types";
import { currentProfile, logout } from "./api";
import { isOnboarded, setOnboarded } from "./preferences";
import { useSkin } from "./skin";
import Aurora from "./components/Aurora";
import OnboardingScreen from "./components/OnboardingScreen";
import LoginScreen from "./components/LoginScreen";
import MainScreen from "./components/MainScreen";
import SettingsScreen from "./components/SettingsScreen";
import TitleBar from "./components/TitleBar";

type View = "onboarding" | "login" | "main" | "settings";

export default function App() {
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [view, setView] = useState<View>("login");
  const [ready, setReady] = useState(false);
  const { reload: reloadSkin } = useSkin();

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
          // key пересоздаёт узел при смене экрана → срабатывает entrance-анимация.
          <div key={view} className="screen-enter">
            {view === "onboarding" && (
              <OnboardingScreen onDone={finishOnboarding} />
            )}
            {view === "login" && (
              <LoginScreen onAuthenticated={handleAuthenticated} />
            )}
            {view === "main" && profile && (
              <MainScreen
                profile={profile}
                onOpenSettings={() => setView("settings")}
                onLogout={handleLogout}
              />
            )}
            {view === "settings" && (
              <SettingsScreen
                profile={profile}
                onProfileChange={setProfile}
                onClose={() => setView("main")}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
