import { useEffect, useState } from "react";
import type { AccountInfo, PlayerProfile } from "../types";
import { accountInfo, changePassword, changeUsername } from "../api";

interface Props {
  profile: PlayerProfile | null;
  onProfileChange: (profile: PlayerProfile) => void;
}

export default function AccountSection({ profile, onProfileChange }: Props) {
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Смена ника.
  const [username, setUsername] = useState("");
  const [nameStatus, setNameStatus] = useState<"idle" | "saving">("idle");
  const [nameMsg, setNameMsg] = useState<string | null>(null);
  const [nameErr, setNameErr] = useState<string | null>(null);

  // Смена пароля.
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwStatus, setPwStatus] = useState<"idle" | "saving">("idle");
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);

  useEffect(() => {
    accountInfo()
      .then((data) => {
        setInfo(data);
        setUsername(data.profile.name);
      })
      .catch((e) =>
        setLoadError(e instanceof Error ? e.message : String(e)),
      );
  }, []);

  async function handleRename(e: React.FormEvent) {
    e.preventDefault();
    setNameMsg(null);
    setNameErr(null);
    const trimmed = username.trim();
    if (trimmed.length < 3) {
      setNameErr("Имя игрока: минимум 3 символа");
      return;
    }
    if (info && trimmed === info.profile.name) {
      setNameErr("Это уже ваш текущий ник");
      return;
    }
    setNameStatus("saving");
    try {
      const updated = await changeUsername(trimmed);
      onProfileChange(updated);
      setInfo((prev) => (prev ? { ...prev, profile: updated } : prev));
      setUsername(updated.name);
      setNameMsg("Ник обновлён");
    } catch (e) {
      setNameErr(e instanceof Error ? e.message : String(e));
    } finally {
      setNameStatus("idle");
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    setPwErr(null);
    if (newPassword.length < 6) {
      setPwErr("Пароль: минимум 6 символов");
      return;
    }
    if (newPassword !== confirmPassword) {
      setPwErr("Пароли не совпадают");
      return;
    }
    setPwStatus("saving");
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPwMsg("Пароль изменён");
    } catch (e) {
      setPwErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPwStatus("idle");
    }
  }

  if (loadError) {
    return <p className="muted">Не удалось загрузить аккаунт: {loadError}</p>;
  }

  const displayName = info?.profile.name ?? profile?.name ?? "—";
  const uuid = info?.profile.id ?? profile?.id ?? "";

  return (
    <div className="account-section">
      <div className="info-card">
        <div className="info-card__row">
          <span className="muted">Ник</span>
          <span>{displayName}</span>
        </div>
        <div className="info-card__row">
          <span className="muted">UUID</span>
          <span className="info-card__path" title={uuid}>
            {uuid}
          </span>
        </div>
        <div className="info-card__row">
          <span className="muted">Роль</span>
          <span className="badge">
            {info?.isAdmin ? "Администратор" : "Игрок"}
          </span>
        </div>
        <div className="info-card__row">
          <span className="muted">Telegram 2FA</span>
          <span className="badge">
            {info?.telegramLinked ? "привязан" : "не привязан"}
          </span>
        </div>
      </div>

      <form className="account-form" onSubmit={handleRename}>
        <span className="toggle-row__title">Сменить ник</span>
        <input
          type="text"
          className="input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Новый ник"
          minLength={3}
        />
        {nameErr && <p className="form-msg form-msg--error">{nameErr}</p>}
        {nameMsg && <p className="form-msg form-msg--ok">{nameMsg}</p>}
        <button
          type="submit"
          className="btn btn--primary"
          disabled={nameStatus === "saving"}
        >
          {nameStatus === "saving" ? "Сохранение…" : "Сохранить ник"}
        </button>
      </form>

      <form className="account-form" onSubmit={handleChangePassword}>
        <span className="toggle-row__title">Сменить пароль</span>
        <input
          type="password"
          className="input"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder="Текущий пароль"
          autoComplete="current-password"
        />
        <input
          type="password"
          className="input"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="Новый пароль"
          autoComplete="new-password"
        />
        <input
          type="password"
          className="input"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="Повторите новый пароль"
          autoComplete="new-password"
        />
        {pwErr && <p className="form-msg form-msg--error">{pwErr}</p>}
        {pwMsg && <p className="form-msg form-msg--ok">{pwMsg}</p>}
        <button
          type="submit"
          className="btn btn--primary"
          disabled={pwStatus === "saving"}
        >
          {pwStatus === "saving" ? "Сохранение…" : "Изменить пароль"}
        </button>
      </form>
    </div>
  );
}
