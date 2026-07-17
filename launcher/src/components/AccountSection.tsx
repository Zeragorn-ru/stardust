import { useEffect, useState } from "react";
import type {
  AccountInfo,
  PlayerProfile,
  TelegramLinkResponse,
} from "../types";
import {
  accountInfo,
  changePassword,
  changeUsername,
  deleteAccount,
  openExternal,
  telegramLinkStart,
  telegramUnlink,
} from "../api";
import PasswordInput from "./PasswordInput";

interface Props {
  profile: PlayerProfile | null;
  onProfileChange: (profile: PlayerProfile) => void;
  onAccountDeleted: () => void;
}

export default function AccountSection({
  profile,
  onProfileChange,
  onAccountDeleted,
}: Props) {
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

  // Auto-hide success messages after 3s.
  useEffect(() => {
    if (!nameMsg) return;
    const t = setTimeout(() => setNameMsg(null), 3000);
    return () => clearTimeout(t);
  }, [nameMsg]);

  useEffect(() => {
    if (!pwMsg) return;
    const t = setTimeout(() => setPwMsg(null), 3000);
    return () => clearTimeout(t);
  }, [pwMsg]);

  // Удаление аккаунта.
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteStatus, setDeleteStatus] = useState<"idle" | "saving">("idle");
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Telegram 2FA: привязка/отвязка.
  const [tgStatus, setTgStatus] = useState<"idle" | "saving">("idle");
  const [tgErr, setTgErr] = useState<string | null>(null);
  const [tgLink, setTgLink] = useState<TelegramLinkResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    accountInfo()
      .then((data) => {
        if (cancelled) return;
        setInfo(data);
        setUsername(data.profile.name);
      })
      .catch((e) =>
        cancelled
          ? undefined
          : setLoadError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  // Пока показан код привязки, опрашиваем сведения об аккаунте: как только бот
  // обработает `/start <code>` и проставит привязку, обновляем UI без ручной
  // перезагрузки страницы.
  useEffect(() => {
    if (!tgLink) return;
    let cancelled = false;

    async function poll() {
      try {
        const data = await accountInfo();
        if (cancelled) return;
        setInfo(data);
        if (data.telegramLinked) {
          // Привязка завершена — убираем панель с кодом.
          setTgLink(null);
        }
      } catch {
        // Сетевые сбои при опросе игнорируем — повторим на следующем тике.
      }
    }

    const timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [tgLink]);

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
      // Сервер при rename может не вернуть ban/cosmetics — мержим с текущим.
      const merged: PlayerProfile = {
        ...(profile ?? updated),
        ...updated,
        ban: updated.ban ?? profile?.ban,
        activeBadge: updated.activeBadge ?? profile?.activeBadge,
        activeGradient: updated.activeGradient ?? profile?.activeGradient,
      };
      onProfileChange(merged);
      setInfo((prev) => (prev ? { ...prev, profile: merged } : prev));
      setUsername(merged.name);
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

  async function handleDeleteAccount(e: React.FormEvent) {
    e.preventDefault();
    setDeleteErr(null);
    if (!deletePassword) {
      setDeleteErr("Введите пароль для подтверждения");
      return;
    }
    setDeleteStatus("saving");
    try {
      await deleteAccount(deletePassword);
      onAccountDeleted();
    } catch (e) {
      setDeleteErr(e instanceof Error ? e.message : String(e));
      setDeleteStatus("idle");
    }
  }

  async function handleLinkTelegram() {
    setTgErr(null);
    setTgStatus("saving");
    try {
      const link = await telegramLinkStart();
      setTgLink(link);
    } catch (e) {
      setTgErr(e instanceof Error ? e.message : String(e));
    } finally {
      setTgStatus("idle");
    }
  }

  async function handleUnlinkTelegram() {
    setTgErr(null);
    setTgStatus("saving");
    try {
      await telegramUnlink();
      setTgLink(null);
      setInfo((prev) => (prev ? { ...prev, telegramLinked: false } : prev));
    } catch (e) {
      setTgErr(e instanceof Error ? e.message : String(e));
    } finally {
      setTgStatus("idle");
    }
  }

  if (loadError) {
    return <p className="muted">Не удалось загрузить аккаунт: {loadError}</p>;
  }

  const displayName = info?.profile.name ?? profile?.name ?? "—";
  const uuid = info?.profile.id ?? profile?.id ?? "";

  return (
    <div className="account-section">
      <div className="info-card stagger-item">
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
          <span
            className={
              "badge " + (info?.telegramLinked ? "badge--ok" : "badge--muted")
            }
          >
            {info?.telegramLinked ? "привязан" : "не привязан"}
          </span>
        </div>
      </div>

      <form className="account-form stagger-item" onSubmit={handleRename}>
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

      <form className="account-form stagger-item" onSubmit={handleChangePassword}>
        <span className="toggle-row__title">Сменить пароль</span>
        <PasswordInput
          value={currentPassword}
          onChange={setCurrentPassword}
          placeholder="Текущий пароль"
        />
        <PasswordInput
          value={newPassword}
          onChange={setNewPassword}
          placeholder="Новый пароль"
        />
        <PasswordInput
          value={confirmPassword}
          onChange={setConfirmPassword}
          placeholder="Повторите новый пароль"
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

      <div className="account-form stagger-item">
        <span className="toggle-row__title">Telegram 2FA</span>
        {info?.telegramLinked ? (
          <>
            <p className="muted">
              Двухфакторная защита включена: при входе нужен код из Telegram.
            </p>
            {tgErr && <p className="form-msg form-msg--error">{tgErr}</p>}
            <button
              type="button"
              className="btn btn--ghost"
              disabled={tgStatus === "saving"}
              onClick={handleUnlinkTelegram}
            >
              {tgStatus === "saving" ? "Отключение…" : "Отключить 2FA"}
            </button>
          </>
        ) : tgLink ? (
          <>
            <p className="muted">
              Откройте бота в Telegram и отправьте команду, чтобы завершить
              привязку. Статус обновится автоматически после подтверждения.
            </p>
            <div className="tg-code">/start {tgLink.code}</div>
            {tgLink.deepLink ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  void openExternal(tgLink.deepLink!);
                }}
              >
                Открыть Telegram
              </button>
            ) : null}
            {tgErr && <p className="form-msg form-msg--error">{tgErr}</p>}
          </>
        ) : (
          <>
            <p className="muted">
              Привяжите Telegram, чтобы включить вход по коду подтверждения.
            </p>
            {tgErr && <p className="form-msg form-msg--error">{tgErr}</p>}
            <button
              type="button"
              className="btn btn--primary"
              disabled={tgStatus === "saving"}
              onClick={handleLinkTelegram}
            >
              {tgStatus === "saving" ? "Подготовка…" : "Привязать Telegram"}
            </button>
          </>
        )}
      </div>

      <form
        className="account-form account-form--danger stagger-item"
        onSubmit={handleDeleteAccount}
      >
        <span className="toggle-row__title">Удалить аккаунт</span>
        <p className="muted">
          Аккаунт и все связанные данные будут удалены безвозвратно.
        </p>
        {confirmingDelete ? (
          <>
            <PasswordInput
              value={deletePassword}
              onChange={setDeletePassword}
              placeholder="Пароль для подтверждения"
            />
            {deleteErr && (
              <p className="form-msg form-msg--error">{deleteErr}</p>
            )}
            <div className="account-form__row">
              <button
                type="button"
                className="btn btn--ghost"
                disabled={deleteStatus === "saving"}
                onClick={() => {
                  setConfirmingDelete(false);
                  setDeletePassword("");
                  setDeleteErr(null);
                }}
              >
                Отмена
              </button>
              <button
                type="submit"
                className="btn btn--danger"
                disabled={deleteStatus === "saving"}
              >
                {deleteStatus === "saving" ? "Удаление…" : "Удалить навсегда"}
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => setConfirmingDelete(true)}
          >
            Удалить аккаунт
          </button>
        )}
      </form>
    </div>
  );
}
