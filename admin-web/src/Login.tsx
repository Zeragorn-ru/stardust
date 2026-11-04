// Вход в десктопную админку. Логика прежняя; карточка переведена на рецепт
// m-login-card/m-brand-mark (план 3.9) — первый экран соответствует
// приложению, легаси brand-dot со старым синим свечением упразднён.

import { useState } from "react";
import { api, ApiError } from "./api";

export function Login({ onLoggedIn }: { onLoggedIn: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (challenge) {
        const res = await api.login2fa(challenge, code.trim());
        onLoggedIn(res.username ?? username.trim());
      } else {
        const res = await api.login(username.trim(), password);
        if (res.status === "two_factor_required" && res.challenge) {
          setChallenge(res.challenge);
        } else {
          onLoggedIn(res.username ?? username.trim());
        }
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <img className="login-brand-mark" src="/stardust-logo.svg?v=palette-lunar" alt="" />
          <span>StarDust</span>
        </div>
        <p className="muted login-card__sub">Вход в панель управления</p>
        {error && <div className="error" role="alert">{error}</div>}
        {challenge ? (
          <>
            <p className="muted login-card__sub">
              Аккаунт защищён Telegram-подтверждением: код отправлен в чат с ботом
              (или подтвердите вход кнопкой) и введите его здесь.
            </p>
            <div className="field">
              <label htmlFor="tf">Код из Telegram</label>
              <input
                id="tf"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                autoComplete="one-time-code"
                inputMode="numeric"
              />
            </div>
          </>
        ) : (
          <>
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
          </>
        )}
        <button
          className="primary block"
          type="submit"
          disabled={busy || (challenge ? !code.trim() : !username.trim() || !password)}
        >
          {busy ? "Вход…" : challenge ? "Подтвердить" : "Войти"}
        </button>
      </form>
    </div>
  );
}
