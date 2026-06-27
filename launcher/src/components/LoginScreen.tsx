import { useEffect, useState } from "react";
import type { ChallengeOutcome, PlayerProfile } from "../types";
import {
  login,
  login2fa,
  login2faStatus,
  passwordlessLogin,
  passwordlessStatus,
  passwordResetConfirm,
  passwordResetStart,
  passwordResetStatus,
  register,
} from "../api";

interface Props {
  onAuthenticated: (profile: PlayerProfile) => void;
}

type Mode = "login" | "register";

/** Интервал опроса кнопочного подтверждения в Telegram, мс. */
const POLL_INTERVAL_MS = 2000;

/** Какой сценарий подтверждается кнопкой — влияет на эндпоинт опроса. */
type ApprovalKind = "login2fa" | "passwordless" | "passwordReset";

/** Состояние ожидания кода 2FA: challenge из ответа login + подсказка. */
interface TwoFactorState {
  challenge: string;
  hint?: string;
}

/** Состояние ожидания подтверждения кнопкой «Это я» в Telegram. */
interface ApprovalState {
  kind: ApprovalKind;
  challenge: string;
  hint?: string;
}

export default function LoginScreen({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [twoFactor, setTwoFactor] = useState<TwoFactorState | null>(null);
  const [code, setCode] = useState("");
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const [resetChallenge, setResetChallenge] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");

  function resetTransient() {
    setError(null);
    setTwoFactor(null);
    setCode("");
    setApproval(null);
    setResetChallenge(null);
    setNewPassword("");
    setNewPasswordConfirm("");
  }

  function switchMode(next: Mode) {
    setMode(next);
    resetTransient();
  }

  /** Применяет ответ входа: либо завершает, либо переключает на 2FA-форму
   *  (ввод кода) или ожидание кнопочного подтверждения. `kind` различает
   *  обычный вход по паролю и вход без пароля — от него зависит эндпоинт
   *  опроса кнопочного подтверждения. */
  function handleLoginOutcome(
    result: Awaited<ReturnType<typeof login>>,
    kind: "login2fa" | "passwordless" = "login2fa",
  ) {
    if (result.status === "twoFactorRequired") {
      if (result.buttonApproval) {
        setApproval({
          kind,
          challenge: result.challenge,
          hint: result.hint,
        });
      } else {
        setTwoFactor({ challenge: result.challenge, hint: result.hint });
      }
    } else {
      onAuthenticated(result.profile);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        handleLoginOutcome(await login(username.trim(), password));
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

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    // Код можно вводить как с отдельного экрана 2FA, так и с экрана ожидания
    // кнопочного подтверждения (login/passwordless), если пользователь
    // предпочитает ввести код вручную вместо нажатия кнопки.
    const challenge = twoFactor?.challenge ?? approval?.challenge;
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const profile = await login2fa(challenge, code.trim());
      onAuthenticated(profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function cancelTwoFactor() {
    setTwoFactor(null);
    setCode("");
    setError(null);
  }

  /** Вход без пароля: по нику, подтверждается кнопкой в Telegram. */
  async function handlePasswordless() {
    if (!username.trim()) {
      setError("Введите логин");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await passwordlessLogin(username.trim());
      handleLoginOutcome(result, "passwordless");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Старт сброса пароля: по нику, подтверждается кнопкой в Telegram. */
  async function handleResetStart() {
    if (!username.trim()) {
      setError("Введите логин для сброса пароля");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await passwordResetStart(username.trim());
      if (result.status === "twoFactorRequired") {
        setApproval({
          kind: "passwordReset",
          challenge: result.challenge,
          hint: result.hint,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function cancelApproval() {
    setApproval(null);
    setCode("");
    setError(null);
  }

  async function handleResetConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (!resetChallenge) return;
    if (newPassword !== newPasswordConfirm) {
      setError("Пароли не совпадают");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await passwordResetConfirm(resetChallenge, newPassword);
      // Пароль сменён; возвращаемся к форме входа с предзаполненным ником.
      setResetChallenge(null);
      setNewPassword("");
      setNewPasswordConfirm("");
      setPassword("");
      setMode("login");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Опрос кнопочного подтверждения. Запускается, пока активно `approval`,
  // и очищается при размонтировании/смене состояния.
  useEffect(() => {
    if (!approval) return;
    let cancelled = false;

    async function poll() {
      // approval гарантированно не null внутри эффекта.
      const active = approval!;
      let outcome: ChallengeOutcome;
      try {
        if (active.kind === "login2fa") {
          outcome = await login2faStatus(active.challenge);
        } else if (active.kind === "passwordless") {
          outcome = await passwordlessStatus(active.challenge);
        } else {
          outcome = await passwordResetStatus(active.challenge);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setApproval(null);
        return;
      }
      if (cancelled) return;

      switch (outcome.status) {
        case "pending":
          break;
        case "approved":
          if (active.kind === "passwordReset") {
            // Подтверждено: переходим к вводу нового пароля.
            setApproval(null);
            setResetChallenge(active.challenge);
          } else if (outcome.profile) {
            setApproval(null);
            onAuthenticated(outcome.profile);
          }
          break;
        case "denied":
          setApproval(null);
          setError("Запрос отклонён в Telegram");
          break;
        case "expired":
          setApproval(null);
          setError("Срок подтверждения истёк, попробуйте снова");
          break;
      }
    }

    const timer = setInterval(poll, POLL_INTERVAL_MS);
    // Первый опрос сразу, не дожидаясь интервала.
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [approval, onAuthenticated]);

  const isRegister = mode === "register";

  // Экран ожидания кнопочного подтверждения в Telegram.
  if (approval) {
    const title =
      approval.kind === "passwordReset"
        ? "Подтвердите сброс пароля"
        : "Подтвердите вход";
    // Для входа (2FA/без пароля) код подтверждения можно ввести вручную —
    // это альтернатива кнопке «Это я». При сбросе пароля сессия не выдаётся,
    // поэтому ручной ввод кода здесь не предлагаем.
    const allowManualCode = approval.kind !== "passwordReset";
    return (
      <div className="login">
        <div className="login__brand">
          <h1>StarDust</h1>
          <p className="muted">
            {approval.hint ?? "Нажмите кнопку в Telegram, чтобы подтвердить"}
          </p>
        </div>

        <div className="login__form">
          <p className="muted">{title}: ожидаем ответ из Telegram…</p>
          {allowManualCode && (
            <form className="login__form" onSubmit={handleVerify}>
              <label className="field">
                <span>Или введите код из Telegram</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  disabled={busy}
                />
              </label>
              <button
                className="btn btn--primary"
                type="submit"
                disabled={busy || !code.trim()}
              >
                {busy ? "Проверка…" : "Подтвердить кодом"}
              </button>
            </form>
          )}
          {error && <div className="alert alert--error">{error}</div>}
          <button
            className="btn btn--ghost"
            type="button"
            onClick={cancelApproval}
          >
            Отмена
          </button>
        </div>
      </div>
    );
  }

  // Экран ввода нового пароля после подтверждённого сброса.
  if (resetChallenge) {
    return (
      <div className="login">
        <div className="login__brand">
          <h1>StarDust</h1>
          <p className="muted">Задайте новый пароль</p>
        </div>

        <form className="login__form" onSubmit={handleResetConfirm}>
          <label className="field">
            <span>Новый пароль</span>
            <input
              type="password"
              autoFocus
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>Повторите пароль</span>
            <input
              type="password"
              value={newPasswordConfirm}
              onChange={(e) => setNewPasswordConfirm(e.target.value)}
              placeholder="••••••••"
              disabled={busy}
            />
          </label>

          {error && <div className="alert alert--error">{error}</div>}

          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? "Сохранение…" : "Сохранить пароль"}
          </button>
          <button
            className="btn btn--ghost"
            type="button"
            onClick={() => {
              resetTransient();
            }}
            disabled={busy}
          >
            Назад
          </button>
        </form>
      </div>
    );
  }

  if (twoFactor) {
    return (
      <div className="login">
        <div className="login__brand">
          <h1>StarDust</h1>
          <p className="muted">
            {twoFactor.hint ?? "Введите код из Telegram"}
          </p>
        </div>

        <form className="login__form" onSubmit={handleVerify}>
          <label className="field">
            <span>Код подтверждения</span>
            <input
              type="text"
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              disabled={busy}
            />
          </label>

          {error && <div className="alert alert--error">{error}</div>}

          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? "Проверка…" : "Подтвердить"}
          </button>
          <button
            className="btn btn--ghost"
            type="button"
            onClick={cancelTwoFactor}
            disabled={busy}
          >
            Назад
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="login stagger">
      <div className="login__brand stagger-item">

        <h1>StarDust</h1>
        <p className="muted">
          {isRegister ? "Создайте аккаунт" : "Войдите, чтобы продолжить"}
        </p>
      </div>

      <div className="tabs stagger-item">
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

      <form className="login__form stagger-item" onSubmit={handleSubmit}>
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

        {!isRegister && (
          <div className="login__alt">
            <button
              className="btn btn--ghost"
              type="button"
              onClick={handlePasswordless}
              disabled={busy}
            >
              Войти без пароля
            </button>
            <button
              className="btn btn--link"
              type="button"
              onClick={handleResetStart}
              disabled={busy}
            >
              Забыли пароль?
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
