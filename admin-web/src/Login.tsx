import { useState } from "react";
import { api, ApiError } from "./api";

export function Login({ onLoggedIn }: { onLoggedIn: (username: string) => void }) {
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
    <div className="login-wrap">
      <form className="panel login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="brand-dot" />
          <span>Вход в админку</span>
        </div>
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
