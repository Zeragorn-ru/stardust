import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import type { Account } from "../types";
import { useToast } from "../ui/feedback";
import { SkinHead } from "../ui/SkinHead";
import { IconSearch, IconSync } from "../ui/icons";
import { PlayerCardModal } from "../ui/PlayerCardModal";

function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

export function AccountsView() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selfUuid, setSelfUuid] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [syncing, setSyncing] = useState(false);

  async function syncStats() {
    setSyncing(true);
    try {
      const res = await api.syncStats();
      toast.success(`Статистика обновлена: ${res.updated} игроков`);
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Ошибка синхронизации",
      );
    } finally {
      setSyncing(false);
    }
  }

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

  return (
    <div className="view accounts-view">
      <header className="view-head page-head">
        <div>
          <span className="eyebrow">Player directory</span>
          <h1>Аккаунты</h1>
          <p className="muted">
            {accounts.length} всего · {adminCount} админ(ов) · {bannedCount} в бане
          </p>
        </div>
        <div className="head-actions">
          <button className="secondary icon-btn" onClick={syncStats} disabled={syncing}>
            <IconSync size={14} className={syncing ? "spin" : ""} />
            {syncing ? "Синхронизация..." : "Синхр. статистики"}
          </button>
          <div className="search">
            <IconSearch />
            <input
              placeholder="Поиск по нику или UUID"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      </header>

      <div className="ops-grid accounts-metrics">
        <div className="metric-card metric-card--blue"><span>Всего</span><strong>{accounts.length}</strong><small>зарегистрированных игроков</small></div>
        <div className="metric-card metric-card--green"><span>Админы</span><strong>{adminCount}</strong><small>расширенный доступ</small></div>
        <div className="metric-card metric-card--yellow"><span>Telegram</span><strong>{accounts.filter((a) => a.telegramLinked).length}</strong><small>аккаунтов привязано</small></div>
        <div className="metric-card metric-card--red"><span>Баны</span><strong>{bannedCount}</strong><small>ограниченный доступ</small></div>
      </div>

      <div className="panel panel-flat table-panel">
        {loading ? (
          <p className="muted">
            <span className="spinner" />
            Загрузка…
          </p>
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
                <th>TG</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => {
                const isSelf = selfUuid === normalizeUuid(a.uuid);
                return (
                  <tr
                    key={a.uuid}
                    className="clickable-row account-row"
                    onClick={() => setSelectedAccount(a)}
                  >
                    <td>
                      <div className="cell-main">
                        <SkinHead
                          uuid={a.uuid}
                          username={a.username}
                          size={32}
                        />
                        <strong>{a.username}</strong>
                        {isSelf && <span className="badge">вы</span>}
                        {a.banned && (
                          <span
                            className="badge banned"
                            title={a.banReason || undefined}
                          >
                            бан
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="mono muted" data-label="UUID">
                      {a.uuid}
                    </td>
                    <td data-label="Роль">
                      {a.isAdmin ? (
                        <span className="badge admin">админ</span>
                      ) : (
                        <span className="badge">игрок</span>
                      )}
                    </td>
                    <td data-label="TG">
                      {a.telegramLinked ? (
                        <span className="badge admin">привязан</span>
                      ) : (
                        <span className="badge muted">нет</span>
                      )}
                    </td>
                    <td>
                      <span className="row-arrow">→</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {selectedAccount && (
        <PlayerCardModal
          account={selectedAccount}
          onClose={() => setSelectedAccount(null)}
          onUpdated={(updated) => {
            setAccounts((prev) => prev.map((a) => (a.uuid === updated.uuid ? updated : a)));
            setSelectedAccount(updated);
          }}
          onDeleted={(uuid) => {
            setAccounts((prev) => prev.filter((a) => a.uuid !== uuid));
            setSelectedAccount(null);
          }}
        />
      )}
    </div>
  );
}

