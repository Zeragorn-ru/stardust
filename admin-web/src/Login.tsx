// Вход в десктопную админку. Логика прежняя; карточка переведена на рецепт
// m-login-card/m-brand-mark (план 3.9) — первый экран соответствует
// приложению, легаси brand-dot со старым синим свечением упразднён.

import { useEffect, useRef, useState } from "react";
import { api, ApiError, setToken } from "./api";

export function Login({ onLoggedIn }: { onLoggedIn: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Опрос завершён (подтверждено/отклонено/истекло): второй раз не дёргаем.
  const settled = useRef(false);
  // Пока идёт ручной ввод кода, не опрашиваем: verify_2fa удаляет challenge,
  // и параллельный poll принял бы это за истечение.
  const manual = useRef(false);

  // Кнопка «✅ Это я» в Telegram не требует ввода кода — сервер отдаёт сессию
  // по опросу статуса challenge. Без этого вход кнопкой просто зависал.
  useEffect(() => {
    if (!challenge) return;
    settled.current = false;
    manual.current = false;
    let stopped = false;
    let timer = 0;
    // Подряд идущие сетевые сбои/5xx. Без потолка вкладка с лежащим сервером
    // опрашивала бы его вечно и пользователь не узнал бы об истечении входа.
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
        // Запросы строго последовательные: `poll_challenge` атомарно
        // забирает approved-запись, и параллельный опрос получил бы
        // «expired» уже после успешного подтверждения.
        const res = await api.login2faStatus(challenge);
        if (stopped || settled.current) return;
        failures = 0;
        // Пока запрос летел, начался ручной ввод кода. Ждём, пока он
        // закончится, — но только для `pending`: `denied`/`expired` означают,
        // что сервер уже изъял challenge, и ручной `verify_2fa` всё равно
        // вернёт 401. Их показываем всегда.
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
        // 4xx — терминальный отказ (роль отозвана, аккаунт забанен):
        // опрос прекращаем, возвращаем форму.
        if (err instanceof ApiError && err.status < 500) {
          settled.current = true;
          finish();
          setError(err.message);
          setChallenge(null);
          return;
        }
        // 5xx и сеть: challenge живёт 5 минут, пробуем ещё. После пяти
        // подряд неудач выходим из ожидания, а не крутим запросы вечно.
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
        // Аккаунт забанен или разжалован — challenge больше не нужен, и
        // опрос не должен перезаписать это сообщение своим «истёк».
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
