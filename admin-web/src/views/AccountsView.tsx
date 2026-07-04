import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import type { Account } from "../types";
import { useToast } from "../ui/feedback";
import { SkinHead } from "../ui/SkinHead";
import { IconSearch } from "../ui/icons";
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
                    className="clickable-row"
                    onClick={() => setSelectedAccount(a)}
                    style={{ cursor: "pointer" }}
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
                      <span className="muted" style={{ fontSize: 12 }}>→</span>
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


