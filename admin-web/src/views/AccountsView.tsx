import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import type { Account } from "../types";
import { useToast } from "../ui/feedback";
import { IconSearch, IconStar } from "../ui/icons";

export function AccountsView() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

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

  return (
    <div className="view">
      <header className="view-head">
        <div>
          <h1>Аккаунты</h1>
          <p className="muted">
            {accounts.length} всего · {adminCount} админ(ов)
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
            {accounts.length === 0 ? "Аккаунтов пока нет." : "Ничего не найдено."}
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Игрок</th>
                <th>UUID</th>
                <th>Роль</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.uuid}>
                  <td>
                    <div className="cell-main">
                      <span className="avatar" aria-hidden="true">
                        {a.username.slice(0, 1).toUpperCase()}
                      </span>
                      <strong>{a.username}</strong>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
