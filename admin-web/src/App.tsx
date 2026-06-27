import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, getToken, setToken } from "./api";
import { Login } from "./Login";
import { BuildsView } from "./views/BuildsView";
import { AccountsView } from "./views/AccountsView";
import { SettingsView } from "./views/SettingsView";
import { FeedbackProvider } from "./ui/feedback";
import { IconBox, IconLogout, IconSettings, IconUsers } from "./ui/icons";

type Tab = "builds" | "accounts" | "settings";

export function App() {
  return (
    <FeedbackProvider>
      <Root />
    </FeedbackProvider>
  );
}

function Root() {
  const [authed, setAuthed] = useState(getToken() !== null);
  const [username, setUsername] = useState<string | null>(null);
  const [checking, setChecking] = useState(getToken() !== null);

  // Проверяем сохранённый токен при старте.
  useEffect(() => {
    if (!getToken()) return;
    let active = true;
    api
      .me()
      .then((me) => {
        if (!active) return;
        setUsername(me.username);
        setAuthed(true);
      })
      .catch(() => {
        if (!active) return;
        setToken(null);
        setAuthed(false);
      })
      .finally(() => active && setChecking(false));
    return () => {
      active = false;
    };
  }, []);

  async function logout() {
    await api.logout();
    setAuthed(false);
    setUsername(null);
  }

  if (checking) {
    return (
      <div className="login-wrap muted">
        <span className="spinner" />
        Проверка сессии…
      </div>
    );
  }

  if (!authed) {
    return (
      <Login
        onLoggedIn={(name) => {
          setUsername(name);
          setAuthed(true);
        }}
      />
    );
  }

  return <Shell username={username} onLogout={logout} />;
}

function Shell({
  username,
  onLogout,
}: {
  username: string | null;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<Tab>(() => {
    const saved = localStorage.getItem("admin.tab");
    return saved === "builds" || saved === "accounts" || saved === "settings"
      ? saved
      : "builds";
  });

  // Сохраняем активную вкладку, чтобы при обновлении страницы не кидало
  // обратно на «Сборки».
  useEffect(() => {
    localStorage.setItem("admin.tab", tab);
  }, [tab]);

  const navItems: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: "builds", label: "Сборки", icon: <IconBox /> },
    { id: "accounts", label: "Аккаунты", icon: <IconUsers /> },
    { id: "settings", label: "Настройки", icon: <IconSettings /> },
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          StarDust
        </div>
        <nav className="nav">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item${tab === item.id ? " active" : ""}`}
              onClick={() => setTab(item.id)}
            >
              {item.icon} {item.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          {username && (
            <div className="who" title={username}>
              <span className="who-avatar">
                {username.charAt(0).toUpperCase()}
              </span>
              <span className="who-name">{username}</span>
            </div>
          )}
          <button className="nav-item" onClick={onLogout}>
            <IconLogout /> Выйти
          </button>
        </div>
      </aside>
      <main className="content">
        {tab === "builds" && <BuildsView />}
        {tab === "accounts" && <AccountsView />}
        {tab === "settings" && <SettingsView />}
      </main>
    </div>
  );
}
