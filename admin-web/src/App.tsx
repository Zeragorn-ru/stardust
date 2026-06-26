import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken } from "./api";
import type { BuildHeader } from "./types";
import { Login } from "./Login";
import { CreateBuildForm } from "./CreateBuildForm";
import { BuildDetail } from "./BuildDetail";

export function App() {
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

  return (
    <>
      <div className="topbar">
        <h1>Админка сборки</h1>
        <div className="user">
          {username && <span>{username}</span>}
          <button onClick={logout}>Выйти</button>
        </div>
      </div>
      <Dashboard />
    </>
  );
}

function Dashboard() {
  const [builds, setBuilds] = useState<BuildHeader[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await api.listBuilds();
      setBuilds(list);
      setSelected((cur) => {
        if (cur !== null && list.some((b) => b.id === cur)) return cur;
        const active = list.find((b) => b.isActive);
        return active?.id ?? list[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить сборки");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function removeBuild(id: number, name: string) {
    if (!confirm(`Удалить сборку «${name}» со всеми файлами?`)) return;
    try {
      await api.deleteBuild(id);
      if (selected === id) setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось удалить сборку");
    }
  }

  return (
    <div className="container">
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <h2>Сборки</h2>
        {loading ? (
          <p className="muted">Загрузка…</p>
        ) : builds.length === 0 ? (
          <p className="muted">Сборок пока нет. Создайте первую ниже.</p>
        ) : (
          <ul className="build-list">
            {builds.map((b) => (
              <li
                key={b.id}
                className={`build-item${selected === b.id ? " selected" : ""}`}
                onClick={() => setSelected(b.id)}
              >
                <div>
                  <strong>{b.name}</strong>{" "}
                  <span className="meta">
                    v{b.version} · {b.loaderKind} · MC {b.mcVersion}
                  </span>
                </div>
                <div className="user">
                  {b.isActive && <span className="badge active">активная</span>}
                  <button
                    className="danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeBuild(b.id, b.name);
                    }}
                  >
                    Удалить
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected !== null && <BuildDetail buildId={selected} onChanged={load} />}

      <CreateBuildForm onCreated={load} />
    </div>
  );
}
