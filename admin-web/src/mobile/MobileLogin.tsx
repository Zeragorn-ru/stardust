// Вход для мобильного интерфейса. Логика та же, что на десктопе, но верстка —
// на всю ширину экрана с крупными полями.

import { useState } from "react";
import { api, ApiError } from "../api";

export function MobileLogin({
  onLoggedIn,
}: {
  onLoggedIn: (username: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.login(username.trim(), password);
      onLoggedIn(res.username);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="m-login">
      <form className="m-login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="m-brand-mark"><span /></span>
          <span>StarDust</span>
        </div>
        <p className="muted">Вход в админку</p>
        {error && <div className="error">{error}</div>}
        <div className="field">
          <label htmlFor="u">Логин</label>
          <input
            id="u"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
          />
        </div>
        <div className="field">
          <label htmlFor="p">Пароль</label>
          <input
            id="p"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <button
          className="primary block"
          type="submit"
          disabled={busy || !username.trim() || !password}
        >
          {busy ? "Вход…" : "Войти"}
        </button>
      </form>
    </div>
  );
}
