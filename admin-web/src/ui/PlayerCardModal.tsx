// Модальное окно карточки игрока с вкладками: Общее, Бейджи, Действия.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Account, Badge, Gradient, PlayerStats } from "../types";
import { useBodyScrollLock } from "../ui/useBodyScrollLock";
import { SkinHead } from "../ui/SkinHead";
import { useConfirm, useToast } from "./feedback";

type Tab = "info" | "badges" | "actions";

interface Props {
  account: Account;
  onClose: () => void;
  onUpdated: (account: Account) => void;
  onDeleted: (uuid: string) => void;
}

export function PlayerCardModal({ account, onClose, onUpdated, onDeleted }: Props) {
  const [tab, setTab] = useState<Tab>("info");
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useBodyScrollLock();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal-wide player-card-modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка */}
        <div className="pc-head">
          <SkinHead uuid={account.uuid} username={account.username} size={48} />
          <div className="pc-head__text">
            <div className="pc-head__name">{account.username}</div>
            <div className="pc-head__uuid">
              {account.uuid}
            </div>
          </div>
          <button className="icon-only pc-close" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </div>

        {/* Вкладки */}
        <div className="pc-tabs">
          {([
            ["info", "Общее"],
            ["badges", "Бейджи"],
            ["actions", "Действия"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              className={"pc-tab" + (tab === key ? " active" : "")}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Контент */}
        <div className="pc-body">
          {tab === "info" && (
            <InfoTab account={account} />
          )}
          {tab === "badges" && (
            <BadgesTab account={account} />
          )}
          {tab === "actions" && (
            <ActionsTab
              account={account}
              onClose={onClose}
              onUpdated={onUpdated}
              onDeleted={onDeleted}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Вкладка «Общее» ───

function InfoTab({ account }: { account: Account }) {
  const [stats, setStats] = useState<PlayerStats | null>(null);

  useEffect(() => {
    api.getAccountStats(account.uuid).then(setStats).catch(() => {});
  }, [account.uuid]);

  function formatPlaytime(seconds: number): string {
    if (seconds < 60) return `${seconds} с`;
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m} мин`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem > 0 ? `${h} ч ${rem} мин` : `${h} ч`;
  }

  return (
    <div className="pc-info">
      <table className="pc-info-table">
        <tbody>
          <tr>
            <td className="muted">Роль</td>
            <td>
              {account.isAdmin ? (
                <span className="badge admin">админ</span>
              ) : (
                <span className="badge">игрок</span>
              )}
            </td>
          </tr>
          <tr>
            <td className="muted">Telegram</td>
            <td>
              {account.telegramLinked ? (
                <span className="badge admin">привязан</span>
              ) : (
                <span className="badge muted">нет</span>
              )}
            </td>
          </tr>
          <tr>
            <td className="muted">Бан</td>
            <td>
              {account.banned ? (
                <span className="badge banned">
                  забанен{account.bannedUntil ? ` до ${new Date(account.bannedUntil).toLocaleString()}` : " навсегда"}
                </span>
              ) : (
                <span className="badge">нет</span>
              )}
            </td>
          </tr>
          {stats && (
            <>
              <tr>
                <td className="muted">Время в игре</td>
                <td>{formatPlaytime(stats.playtimeSeconds)}</td>
              </tr>
              <tr>
                <td className="muted">Последний запуск</td>
                <td>
                  {stats.lastLaunchedAt
                    ? new Date(stats.lastLaunchedAt).toLocaleString()
                    : "—"}
                </td>
              </tr>
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─── Вкладка «Бейджи» ───

function BadgesTab({
  account,
}: {
  account: Account;
}) {
  const toast = useToast();
  const [data, setData] = useState<{
    availableBadges: Badge[];
    availableGradients: Gradient[];
    ownedBadgeIds: number[];
    ownedGradientIds: number[];
    activeBadgeId: number | null;
    activeGradientId: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const c = await api.getAccountCustomization(account.uuid);
      setData({
        availableBadges: c.availableBadges,
        availableGradients: c.availableGradients,
        ownedBadgeIds: c.ownedBadgeIds ?? (c.activeBadgeId != null ? [c.activeBadgeId] : []),
        ownedGradientIds: c.ownedGradientIds ?? (c.activeGradientId != null ? [c.activeGradientId] : []),
        activeBadgeId: c.activeBadgeId,
        activeGradientId: c.activeGradientId,
      });
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [account.uuid]);

  useEffect(() => { load(); }, [load]);

  async function toggleBadge(id: number) {
    if (!data) return;
    const owned = data.ownedBadgeIds.includes(id);
    const next = owned
      ? data.ownedBadgeIds.filter((x) => x !== id)
      : [...data.ownedBadgeIds, id];
    setData({
      ...data,
      ownedBadgeIds: next,
      activeBadgeId: data.activeBadgeId === id && owned ? null : data.activeBadgeId,
    });
  }

  async function toggleGradient(id: number) {
    if (!data) return;
    const owned = data.ownedGradientIds.includes(id);
    const next = owned
      ? data.ownedGradientIds.filter((x) => x !== id)
      : [...data.ownedGradientIds, id];
    setData({
      ...data,
      ownedGradientIds: next,
      activeGradientId: data.activeGradientId === id && owned ? null : data.activeGradientId,
    });
  }

  async function save() {
    if (!data) return;
    setSaving(true);
    try {
      await api.setAccountBadges(account.uuid, data.ownedBadgeIds);
      await api.setAccountGradients(account.uuid, data.ownedGradientIds);
      await api.setAccountActive(account.uuid, data.activeBadgeId, data.activeGradientId);
      toast.success("Бейджи и кастомизация сохранены");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Не удалось сохранить бейджи");
    } finally {
      setSaving(false);
    }
  }

  if (loading || !data) {
    return <div className="muted" style={{ padding: 16 }}><span className="spinner" /> Загрузка…</div>;
  }

  return (
    <div className="pc-badges">
      {/* Бейджи — чекбоксы + radio для активного */}
      <div className="pc-section">
        <div className="pc-section-title">Бейджи</div>
        {data.availableBadges.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>Бейджей пока нет. Создайте в разделе «Кастомизация».</p>
        ) : (
          <div className="pc-check-grid">
            {data.availableBadges.map((b) => {
              const owned = data.ownedBadgeIds.includes(b.id);
              const active = data.activeBadgeId === b.id;
              return (
                <label key={b.id} className={"pc-check" + (owned ? " checked" : "")}>
                  <input
                    type="checkbox"
                    checked={owned}
                    onChange={() => toggleBadge(b.id)}
                  />
                  <span className="pc-check-emoji">{b.emoji}</span>
                  <span className="pc-check-label">{b.label}</span>
                  {owned && (
                    <button
                      className={"pc-active-dot" + (active ? " active" : "")}
                      title={active ? "Активный бейдж" : "Сделать активным"}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setData({ ...data, activeBadgeId: active ? null : b.id });
                      }}
                    />
                  )}
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* Градиенты — чекбоксы + radio для активного */}
      <div className="pc-section">
        <div className="pc-section-title">Градиенты</div>
        {data.availableGradients.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>Градиентов пока нет. Создайте в разделе «Кастомизация».</p>
        ) : (
          <div className="pc-check-grid">
            {data.availableGradients.map((g) => {
              const owned = data.ownedGradientIds.includes(g.id);
              const active = data.activeGradientId === g.id;
              return (
                <label key={g.id} className={"pc-check" + (owned ? " checked" : "")}>
                  <input
                    type="checkbox"
                    checked={owned}
                    onChange={() => toggleGradient(g.id)}
                  />
                  <span
                    className="pc-check-swatch"
                    style={{ background: `linear-gradient(90deg, ${g.colorStart}, ${g.colorEnd})` }}
                  />
                  <span className="pc-check-label">{g.label}</span>
                  {owned && (
                    <button
                      className={"pc-active-dot" + (active ? " active" : "")}
                      title={active ? "Активный градиент" : "Сделать активным"}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setData({ ...data, activeGradientId: active ? null : g.id });
                      }}
                    />
                  )}
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* Превью */}
      <div className="pc-preview">
        <span style={{ fontSize: 12, color: "var(--muted)" }}>Превью:</span>
        <span style={{ fontWeight: 600 }}>
          {data.activeBadgeId != null && (
            <span style={{ color: data.availableBadges.find((b) => b.id === data.activeBadgeId)?.color }}>
              {data.availableBadges.find((b) => b.id === data.activeBadgeId)?.emoji}{" "}
            </span>
          )}
          <span
            style={
              data.activeGradientId != null
                ? {
                    background: `linear-gradient(90deg, ${data.availableGradients.find((g) => g.id === data.activeGradientId)?.colorStart}, ${data.availableGradients.find((g) => g.id === data.activeGradientId)?.colorEnd})`,
                    WebkitBackgroundClip: "text",
                    WebkitTextFillColor: "transparent",
                  }
                : undefined
            }
          >
            {account.username}
          </span>
        </span>
      </div>

      <button className="primary" disabled={saving} onClick={save}>
        {saving ? "Сохранение…" : "Сохранить"}
      </button>
    </div>
  );
}

// ─── Вкладка «Действия» ───

function ActionsTab({
  account,
  onClose,
  onUpdated,
  onDeleted,
}: {
  account: Account;
  onClose: () => void;
  onUpdated: (a: Account) => void;
  onDeleted: (uuid: string) => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState(account.username);
  const [password, setPassword] = useState("");
  const [banReason, setBanReason] = useState("");

  async function handleRename(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || username.trim() === account.username) return;
    setBusy(true);
    try {
      onUpdated(await api.renameAccount(account.uuid, username.trim()));
      toast.success("Ник изменен");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 6) return;
    setBusy(true);
    try {
      await api.setPassword(account.uuid, password);
      toast.success("Пароль сброшен");
      setPassword("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function doSetRole() {
    const makeAdmin = !account.isAdmin;
    const ok = await confirm({
      title: makeAdmin ? "Выдать права администратора?" : "Снять права администратора?",
      body: makeAdmin 
        ? `Вы действительно хотите сделать игрока ${account.username} администратором?` 
        : `Вы действительно хотите снять права администратора с ${account.username}?`,
      confirmText: makeAdmin ? "Сделать админом" : "Снять права",
      danger: !makeAdmin,
    });
    if (!ok) return;
    setBusy(true);
    try {
      onUpdated(await api.setRole(account.uuid, makeAdmin ? "admin" : "user"));
      toast.success(makeAdmin ? "Права администратора выданы" : "Права администратора сняты");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function handleBan(e: React.FormEvent) {
    e.preventDefault();
    const ok = await confirm({
      title: `Забанить игрока ${account.username}?`,
      body: banReason ? `Причина: ${banReason}` : "Без указания причины.",
      confirmText: "Забанить",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      onUpdated(await api.banAccount(account.uuid, { reason: banReason.trim() || undefined }));
      toast.success("Игрок забанен");
      setBanReason("");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function handleUnban() {
    const ok = await confirm({
      title: `Разбанить игрока ${account.username}?`,
      body: "Игрок снова сможет заходить на сервер.",
      confirmText: "Разбанить",
    });
    if (!ok) return;
    setBusy(true);
    try {
      onUpdated(await api.unbanAccount(account.uuid));
      toast.success("Бан снят");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    const ok = await confirm({
      title: `Удалить аккаунт ${account.username}?`,
      body: "Это действие необратимо. Будет удалена вся статистика и настройки игрока.",
      confirmText: "Удалить навсегда",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteAccount(account.uuid);
      onDeleted(account.uuid);
      toast.success("Аккаунт удален");
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pc-actions-container" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Смена ника */}
      <form onSubmit={handleRename} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4, display: "block" }}>Сменить ник</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Новый ник"
            disabled={busy}
            style={{ width: "100%" }}
          />
        </div>
        <button type="submit" disabled={busy || !username.trim() || username.trim() === account.username} className="primary" style={{ padding: "8px 14px", height: 38 }}>
          Изменить
        </button>
      </form>

      {/* Сброс пароля */}
      <form onSubmit={handleResetPassword} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4, display: "block" }}>Сбросить пароль</label>
          <input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Новый пароль (от 6 символов)"
            disabled={busy}
            style={{ width: "100%" }}
          />
        </div>
        <button type="submit" disabled={busy || password.length < 6} className="primary" style={{ padding: "8px 14px", height: 38 }}>
          Сбросить
        </button>
      </form>

      {/* Управление правами и банами */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
        <button className="secondary" disabled={busy} onClick={doSetRole} style={{ flex: 1, minWidth: 140, justifyContent: "center" }}>
          {account.isAdmin ? "Снять права админа" : "Сделать админом"}
        </button>

        {account.banned ? (
          <button className="secondary" disabled={busy} onClick={handleUnban} style={{ flex: 1, minWidth: 140, justifyContent: "center" }}>
            Снять бан
          </button>
        ) : null}
      </div>

      {!account.banned && (
        <form onSubmit={handleBan} style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <label style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4, display: "block" }}>Забанить игрока</label>
            <input
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              placeholder="Причина бана (необязательно)"
              disabled={busy || account.isAdmin}
              style={{ width: "100%" }}
            />
          </div>
          <button type="submit" disabled={busy || account.isAdmin} className="danger-solid" style={{ padding: "8px 14px", height: 38 }}>
            Забанить
          </button>
        </form>
      )}

      {/* Удаление аккаунта */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16, marginTop: 12 }}>
        <button
          className="danger-solid"
          disabled={busy || account.isAdmin}
          onClick={doDelete}
          style={{ width: "100%", justifyContent: "center" }}
        >
          Удалить аккаунт
        </button>
      </div>
    </div>
  );
}
