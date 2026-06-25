import { useState } from "react";
import type { PlayerProfile } from "../types";
import { login, register } from "../api";

interface Props {
  onAuthenticated: (profile: PlayerProfile) => void;
}

type Mode = "login" | "register";

export default function LoginScreen({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        const profile = await login(username.trim(), password);
        onAuthenticated(profile);
      } else {
        if (password !== confirm) {
          throw new Error("Пароли не совпадают");
        }
        const profile = await register(username.trim(), password);
        onAuthenticated(profile);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const isRegister = mode === "register";

  return (
    <div className="login">
      <div className="login__brand">
        <div className="login__logo">⛏</div>
        <h1>StarDust</h1>
        <p className="muted">
          {isRegister ? "Создайте аккаунт" : "Войдите, чтобы продолжить"}
        </p>
      </div>

      <div className="tabs">
        <button
          type="button"
          className={"tabs__tab" + (!isRegister ? " is-active" : "")}
          onClick={() => switchMode("login")}
        >
          Вход
        </button>
        <button
          type="button"
          className={"tabs__tab" + (isRegister ? " is-active" : "")}
          onClick={() => switchMode("register")}
        >
          Регистрация
        </button>
      </div>

      <form className="login__form" onSubmit={handleSubmit}>
        <label className="field">
          <span>Логин</span>
          <input
            type="text"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Имя игрока"
            disabled={busy}
          />
        </label>

        <label className="field">
          <span>Пароль</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            disabled={busy}
          />
        </label>

        {isRegister && (
          <label className="field">
            <span>Повторите пароль</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••••"
              disabled={busy}
            />
          </label>
        )}

        {error && <div className="alert alert--error">{error}</div>}

        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy
            ? isRegister
              ? "Создание…"
              : "Вход…"
            : isRegister
              ? "Зарегистрироваться"
              : "Войти"}
        </button>
      </form>
    </div>
  );
}
