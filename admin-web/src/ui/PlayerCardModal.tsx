// Модальное окно карточки игрока с вкладками: Общее, Бейджи, Действия.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Account, Badge, Gradient, PlayerStats } from "../types";
import { useBodyScrollLock } from "../ui/useBodyScrollLock";
import { SkinHead } from "../ui/SkinHead";

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
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <SkinHead uuid={account.uuid} username={account.username} size={48} />
          <div>
            <div style={{ fontSize: 17, fontWeight: 600 }}>{account.username}</div>
            <div style={{ fontSize: 12, color: "var(--muted)", fontFamily: "monospace" }}>
              {account.uuid}
            </div>
          </div>
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
    } catch {
      // ignore
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
  const [busy, setBusy] = useState(false);

  async function doRename() {
    const value = prompt("Новый ник", account.username);
    if (!value || value.trim() === account.username) return;
    setBusy(true);
    try {
      onUpdated(await api.renameAccount(account.uuid, value.trim()));
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function doResetPassword() {
    const pw = prompt("Новый пароль (минимум 6 символов):");
    if (!pw || pw.length < 6) return;
    setBusy(true);
    try {
      await api.setPassword(account.uuid, pw);
      alert("Пароль сброшен");
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function doSetRole() {
    const makeAdmin = !account.isAdmin;
    const ok = confirm(
      makeAdmin
        ? `Выдать ${account.username} права админа?`
        : `Снять с ${account.username} права админа?`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      onUpdated(await api.setRole(account.uuid, makeAdmin ? "admin" : "user"));
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function doBan() {
    const reason = prompt("Причина бана (необязательно):") ?? "";
    setBusy(true);
    try {
      onUpdated(await api.banAccount(account.uuid, { reason: reason || undefined }));
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function doUnban() {
    const ok = confirm(`Снять бан с ${account.username}?`);
    if (!ok) return;
    setBusy(true);
    try {
      onUpdated(await api.unbanAccount(account.uuid));
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    const ok = confirm(`Удалить ${account.username}? Это необратимо.`);
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteAccount(account.uuid);
      onDeleted(account.uuid);
      onClose();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pc-actions">
      <button className="pc-action-btn" disabled={busy} onClick={doRename}>
        Переименовать
      </button>
      <button className="pc-action-btn" disabled={busy} onClick={doResetPassword}>
        Сбросить пароль
      </button>
      <button className="pc-action-btn" disabled={busy} onClick={doSetRole}>
        {account.isAdmin ? "Снять права админа" : "Сделать админом"}
      </button>
      {account.banned ? (
        <button className="pc-action-btn" disabled={busy} onClick={doUnban}>
          Снять бан
        </button>
      ) : (
        <button className="pc-action-btn" disabled={busy || account.isAdmin} onClick={doBan}>
          Забанить
        </button>
      )}
      <button
        className="pc-action-btn danger"
        disabled={busy || account.isAdmin}
        onClick={doDelete}
      >
        Удалить аккаунт
      </button>
    </div>
  );
}
