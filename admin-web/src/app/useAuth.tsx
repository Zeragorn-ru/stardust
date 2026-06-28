// Общая логика сессии для обоих интерфейсов (десктоп `/` и мобильный `/m`).
//
// Держит состояние авторизации в одном месте: проверка сохранённого токена при
// старте, вход и выход. Презентация (формы логина, шеллы) — отдельно у каждого
// интерфейса, а источник правды о сессии — здесь.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api, getToken, setToken } from "../api";

interface AuthState {
  /** null — ещё проверяем сохранённый токен; иначе известно, вошли или нет. */
  authed: boolean | null;
  username: string | null;
  onLoggedIn: (username: string) => void;
  logout: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth вне AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(
    getToken() === null ? false : null,
  );
  const [username, setUsername] = useState<string | null>(null);

  // Проверяем сохранённый токен один раз при старте.
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
      });
    return () => {
      active = false;
    };
  }, []);

  const onLoggedIn = useCallback((name: string) => {
    setUsername(name);
    setAuthed(true);
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUsername(null);
    setAuthed(false);
  }, []);

  return (
    <AuthCtx.Provider value={{ authed, username, onLoggedIn, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}
