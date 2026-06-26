import { useEffect, useState } from "react";
import type { PlayerProfile, UpdateInfo } from "./types";
import { checkUpdate, currentProfile, logout } from "./api";
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

  // Обновление, обнаруженное при старте (показываем всплывашкой).
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

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

  // Проверка обновлений при запуске: если есть новая версия — сразу
  // предлагаем обновиться. Ошибки (нет сети, GitHub недоступен)
  // глотаем молча — это не должно мешать запуску лаунчера.
  useEffect(() => {
    checkUpdate()
      .then((info) => {
        if (info.available) setUpdate(info);
      })
      .catch(() => undefined);
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
                onOpenSettings={(section) => {
                  setSettingsSection(section ?? "general");
                  setView("settings");
                }}
                onLogout={handleLogout}
              />
            )}
            {view === "settings" && (
              <SettingsScreen
                profile={profile}
                onProfileChange={setProfile}
                initialSection={settingsSection}
                onClose={() => setView("main")}
              />
            )}
          </div>
        )}
      </div>
      {update && (
        <UpdateModal update={update} onDismiss={() => setUpdate(null)} />
      )}
    </div>
  );
}
