import { useEffect, useState } from "react";
import { api, getToken, setToken } from "./api";
import { Login } from "./Login";
import { BuildsView } from "./views/BuildsView";
import { AccountsView } from "./views/AccountsView";
import { FeedbackProvider } from "./ui/feedback";
import { IconBox, IconDownload, IconLogout, IconUsers } from "./ui/icons";

type Tab = "builds" | "accounts";

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
    return <div className="login-wrap muted">Проверка сессии…</div>;
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
  const [tab, setTab] = useState<Tab>("builds");

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          StarDust
        </div>
        <nav className="nav">
          <button
            className={`nav-item${tab === "builds" ? " active" : ""}`}
            onClick={() => setTab("builds")}
          >
            <IconBox /> Сборки
          </button>
          <button
            className={`nav-item${tab === "accounts" ? " active" : ""}`}
            onClick={() => setTab("accounts")}
          >
            <IconUsers /> Аккаунты
          </button>
        </nav>
        <div className="sidebar-foot">
          {username && <div className="who">{username}</div>}
          <a
            className="nav-item"
            href="/authlib-injector.jar"
            download="authlib-injector.jar"
          >
            <IconDownload /> authlib-injector
          </a>
          <button className="nav-item" onClick={onLogout}>
            <IconLogout /> Выйти
          </button>
        </div>
      </aside>
      <main className="content">
        {tab === "builds" ? <BuildsView /> : <AccountsView />}
      </main>
    </div>
  );
}
