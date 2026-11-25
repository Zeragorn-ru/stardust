// Экран входа. Логика сессии и 2FA-опроса портирована из проверенной
// версии (последовательный poll, ручной ввод кода, терминальные 4xx).

import { useEffect, useRef, useState } from "react";
import { api, ApiError, setToken } from "../api";
import { Button, Field, Input } from "../ui/components";
import { IconAlert } from "../ui/icons";

export function Login({ onLoggedIn }: { onLoggedIn: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const settled = useRef(false);
  // Пока идёт ручной ввод кода, не опрашиваем: verify_2fa удаляет challenge,
  // и параллельный poll принял бы это за истечение.
  const manual = useRef(false);

  // Кнопка «Это я» в Telegram отдаёт сессию по опросу статуса challenge.
  useEffect(() => {
    if (!challenge) return;
    settled.current = false;
    manual.current = false;
    let stopped = false;
    let timer = 0;
    let failures = 0;
    const finish = () => {
      stopped = true;
      window.clearTimeout(timer);
    };
    const schedule = () => {
      if (!stopped) timer = window.setTimeout(poll, 1500);
    };
    const poll = async () => {
      if (manual.current) {
        schedule();
        return;
      }
      if (stopped || settled.current) return;
      try {
        // Строго последовательные запросы: poll_challenge атомарно забирает
        // approved-запись, параллельный опрос получил бы «expired».
        const res = await api.login2faStatus(challenge);
        if (stopped || settled.current) return;
        failures = 0;
        if (manual.current && res.status === "pending") {
          schedule();
          return;
        }
        if (res.status === "approved" && res.auth) {
          settled.current = true;
          finish();
          setToken(res.auth.token);
          onLoggedIn(res.auth.profile.name);
        } else if (res.status === "denied") {
          settled.current = true;
          finish();
          setError("Вход отклонён в Telegram");
          setChallenge(null);
        } else if (res.status === "expired") {
          settled.current = true;
          finish();
          setError("Запрос входа истёк, войдите заново");
          setChallenge(null);
        } else {
          schedule();
        }
      } catch (err) {
        if (err instanceof ApiError && err.status < 500) {
          settled.current = true;
          finish();
          setError(err.message);
          setChallenge(null);
          return;
        }
        failures += 1;
        if (failures >= 5) {
          settled.current = true;
          finish();
          setError("Не удалось проверить подтверждение входа, попробуйте снова");
          setChallenge(null);
          return;
        }
        schedule();
      }
    };
    void poll();
    return finish;
  }, [challenge, onLoggedIn]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (challenge) {
        manual.current = true;
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
      if (err instanceof ApiError && err.status === 403) {
        // Аккаунт забанен/разжалован: challenge больше не нужен.
        settled.current = true;
        setChallenge(null);
      } else {
        // Неверный код не убивает challenge — возвращаемся к опросу кнопки.
        manual.current = false;
      }
      setError(err instanceof ApiError ? err.message : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <img src="/stardust-logo.svg" alt="" />
          <strong>StarDust</strong>
          <small className="muted">Панель управления</small>
        </div>

        {error && (
          <div className="error-panel" role="alert">
            <IconAlert size={16} />
            {error}
          </div>
        )}

        {challenge ? (
          <>
            <p className="muted" style={{ fontSize: "var(--fs-sm)" }}>
              Код подтверждения отправлен в чат с ботом. Подтвердите вход кнопкой
              или введите код здесь.
            </p>
            <Field label="Код из Telegram">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
                autoComplete="one-time-code"
                inputMode="numeric"
              />
            </Field>
            <Button type="submit" variant="primary" busy={busy} disabled={!code.trim()}>
              Подтвердить
            </Button>
          </>
        ) : (
          <>
            <Field label="Логин">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
              />
            </Field>
            <Field label="Пароль">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={!username.trim() || !password}
            >
              Войти
            </Button>
          </>
        )}
      </form>
    </div>
  );
}
