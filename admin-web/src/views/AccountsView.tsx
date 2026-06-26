import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Account } from "../types";
import { useConfirm, useToast } from "../ui/feedback";
import { SkinHead } from "../ui/SkinHead";
import {
  IconBan,
  IconCheck,
  IconPencil,
  IconSearch,
  IconShield,
  IconShieldOff,
  IconStar,
  IconTrash,
} from "../ui/icons";

function formatBanUntil(iso?: string): string {
  if (!iso) return "навсегда";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `до ${d.toLocaleString()}`;
}

function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

export function AccountsView() {
  const toast = useToast();
  const confirm = useConfirm();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Account | null>(null);
  const [banning, setBanning] = useState<Account | null>(null);
  const [selfUuid, setSelfUuid] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts(await api.listAccounts());
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось загрузить аккаунты",
      );
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  // Свой UUID — чтобы не предлагать снять с себя права/забанить себя.
  useEffect(() => {
    api
      .me()
      .then((me) => setSelfUuid(normalizeUuid(me.uuid)))
      .catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? accounts.filter(
          (a) =>
            a.username.toLowerCase().includes(q) ||
            a.uuid.toLowerCase().includes(q),
        )
      : accounts;
    // Админы сверху, затем по алфавиту.
    return [...list].sort((a, b) => {
      if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
      return a.username.localeCompare(b.username);
    });
  }, [accounts, query]);

  const adminCount = accounts.filter((a) => a.isAdmin).length;
  const bannedCount = accounts.filter((a) => a.banned).length;

  const replace = useCallback((next: Account) => {
    setAccounts((prev) => prev.map((a) => (a.uuid === next.uuid ? next : a)));
  }, []);

  async function doRename(account: Account, username: string) {
    setBusy(account.uuid);
    try {
      replace(await api.renameAccount(account.uuid, username));
      toast.success("Ник изменён");
      setRenaming(null);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось изменить ник",
      );
    } finally {
      setBusy(null);
    }
  }

  async function doBan(
    account: Account,
    durationSecs: number | undefined,
    reason: string,
  ) {
    setBusy(account.uuid);
    try {
      replace(
        await api.banAccount(account.uuid, {
          durationSecs,
          reason: reason || undefined,
        }),
      );
      toast.success("Аккаунт забанен");
      setBanning(null);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось забанить",
      );
    } finally {
      setBusy(null);
    }
  }

  async function doSetRole(account: Account, makeAdmin: boolean) {
    const ok = await confirm({
      title: makeAdmin ? "Выдать права админа?" : "Снять права админа?",
      body: makeAdmin
        ? `${account.username} получит полный доступ к админке.`
        : `${account.username} потеряет доступ к админке.`,
      confirmText: makeAdmin ? "Сделать админом" : "Снять админа",
      danger: !makeAdmin,
    });
    if (!ok) return;
    setBusy(account.uuid);
    try {
      replace(await api.setRole(account.uuid, makeAdmin ? "admin" : "user"));
      toast.success(makeAdmin ? "Права админа выданы" : "Права админа сняты");
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось изменить роль",
      );
    } finally {
      setBusy(null);
    }
  }

  async function doUnban(account: Account) {
    const ok = await confirm({
      title: "Снять бан?",
      body: account.username,
      confirmText: "Снять бан",
    });
    if (!ok) return;
    setBusy(account.uuid);
    try {
      replace(await api.unbanAccount(account.uuid));
      toast.success("Бан снят");
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось снять бан",
      );
    } finally {
      setBusy(null);
    }
  }

  async function doDelete(account: Account) {
    const ok = await confirm({
      title: "Удалить аккаунт?",
      body: `${account.username} — действие необратимо.`,
      confirmText: "Удалить",
      danger: true,
    });
    if (!ok) return;
    setBusy(account.uuid);
    try {
      await api.deleteAccount(account.uuid);
      setAccounts((prev) => prev.filter((a) => a.uuid !== account.uuid));
      toast.success("Аккаунт удалён");
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Не удалось удалить аккаунт",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>Аккаунты</h1>
          <p className="muted">
            {accounts.length} всего · {adminCount} админ(ов) · {bannedCount} в
            бане
          </p>
        </div>
        <div className="search">
          <IconSearch />
          <input
            placeholder="Поиск по нику или UUID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </header>

      <div className="panel">
        {loading ? (
          <p className="muted">Загрузка…</p>
        ) : filtered.length === 0 ? (
          <p className="muted">
            {accounts.length === 0
              ? "Аккаунтов пока нет."
              : "Ничего не найдено."}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Игрок</th>
                <th>UUID</th>
                <th>Роль</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => {
                const isSelf = selfUuid === normalizeUuid(a.uuid);
                return (
                  <tr key={a.uuid}>
                    <td>
                      <div className="cell-main">
                        <SkinHead uuid={a.uuid} username={a.username} size={32} />
                        <strong>{a.username}</strong>
                        {isSelf && <span className="badge">вы</span>}
                        {a.banned && (
                          <span
                            className="badge banned"
                            title={a.banReason || undefined}
                          >
                            бан · {formatBanUntil(a.bannedUntil)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="mono muted">{a.uuid}</td>
                    <td>
                      {a.isAdmin ? (
                        <span className="badge admin">
                          <IconStar size={12} /> админ
                        </span>
                      ) : (
                        <span className="badge">игрок</span>
                      )}
                    </td>
                    <td className="row-actions">
                      <button
                        className="icon-only"
                        title="Переименовать"
                        disabled={busy === a.uuid}
                        onClick={() => setRenaming(a)}
                      >
                        <IconPencil size={15} />
                      </button>
                      {a.isAdmin ? (
                        <button
                          className="icon-only"
                          title="Снять права админа"
                          disabled={busy === a.uuid || isSelf}
                          onClick={() => doSetRole(a, false)}
                        >
                          <IconShieldOff size={15} />
                        </button>
                      ) : (
                        <button
                          className="icon-only"
                          title="Сделать админом"
                          disabled={busy === a.uuid}
                          onClick={() => doSetRole(a, true)}
                        >
                          <IconShield size={15} />
                        </button>
                      )}
                      {a.banned ? (
                        <button
                          className="icon-only"
                          title="Снять бан"
                          disabled={busy === a.uuid}
                          onClick={() => doUnban(a)}
                        >
                          <IconCheck size={15} />
                        </button>
                      ) : (
                        <button
                          className="icon-only"
                          title="Забанить"
                          disabled={busy === a.uuid || a.isAdmin}
                          onClick={() => setBanning(a)}
                        >
                          <IconBan size={15} />
                        </button>
                      )}
                      <button
                        className="danger icon-only"
                        title="Удалить аккаунт"
                        disabled={busy === a.uuid || a.isAdmin}
                        onClick={() => doDelete(a)}
                      >
                        <IconTrash size={15} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {renaming && (
        <RenameDialog
          account={renaming}
          busy={busy === renaming.uuid}
          onCancel={() => setRenaming(null)}
          onSubmit={(name) => doRename(renaming, name)}
        />
      )}
      {banning && (
        <BanDialog
          account={banning}
          busy={busy === banning.uuid}
          onCancel={() => setBanning(null)}
          onSubmit={(secs, reason) => doBan(banning, secs, reason)}
        />
      )}
    </div>
  );
}

function RenameDialog({
  account,
  busy,
  onCancel,
  onSubmit,
}: {
  account: Account;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (username: string) => void;
}) {
  const [value, setValue] = useState(account.username);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== account.username && !busy;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Переименовать аккаунт</h3>
        <label className="fm-prompt-field">
          <span className="muted">Новый ник</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) onSubmit(trimmed);
            }}
          />
        </label>
        <div className="modal-actions">
          <button onClick={onCancel}>Отмена</button>
          <button
            className="primary"
            disabled={!canSubmit}
            onClick={() => onSubmit(trimmed)}
          >
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}

const BAN_DURATIONS: { label: string; secs: number | undefined }[] = [
  { label: "1 час", secs: 3600 },
  { label: "1 день", secs: 86400 },
  { label: "1 неделя", secs: 604800 },
  { label: "30 дней", secs: 2592000 },
  { label: "Навсегда", secs: undefined },
];

function BanDialog({
  account,
  busy,
  onCancel,
  onSubmit,
}: {
  account: Account;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (durationSecs: number | undefined, reason: string) => void;
}) {
  const [durationIdx, setDurationIdx] = useState(BAN_DURATIONS.length - 1);
  const [reason, setReason] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Забанить {account.username}</h3>
        <label className="fm-prompt-field">
          <span className="muted">Длительность</span>
          <div className="seg">
            {BAN_DURATIONS.map((d, i) => (
              <button
                key={d.label}
                className={`seg-btn${durationIdx === i ? " active" : ""}`}
                onClick={() => setDurationIdx(i)}
              >
                {d.label}
              </button>
            ))}
          </div>
        </label>
        <label className="fm-prompt-field">
          <span className="muted">Причина (необязательно)</span>
          <input
            value={reason}
            placeholder="напр. нарушение правил"
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div className="modal-actions">
          <button onClick={onCancel}>Отмена</button>
          <button
            className="danger-solid"
            disabled={busy}
            onClick={() =>
              onSubmit(BAN_DURATIONS[durationIdx].secs, reason.trim())
            }
          >
            Забанить
          </button>
        </div>
      </div>
    </div>
  );
}
