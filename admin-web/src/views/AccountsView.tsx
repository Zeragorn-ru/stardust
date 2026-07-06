import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import type { Account, PlayerStats } from "../types";
import { useToast } from "../ui/feedback";
import { SkinHead } from "../ui/SkinHead";
import { IconSearch, IconSync } from "../ui/icons";
import { PlayerCardModal } from "../ui/PlayerCardModal";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/shadcn";

function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

function formatPlaytime(seconds?: number): string {
  if (seconds == null) return "—";
  if (seconds < 60) return String(seconds) + "с";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return String(m) + "м";
  return String(h) + "ч " + String(m) + "м";
}

function formatLastJoin(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function AccountsView() {
  const toast = useToast();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selfUuid, setSelfUuid] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [accountStats, setAccountStats] = useState<Record<string, PlayerStats>>({});

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
      const nextAccounts = await api.listAccounts();
      setAccounts(nextAccounts);

      const statsEntries = await Promise.allSettled(
        nextAccounts.map(async (account) => [
          account.uuid,
          await api.getAccountStats(account.uuid),
        ] as const),
      );
      const nextStats: Record<string, PlayerStats> = {};
      for (const result of statsEntries) {
        if (result.status === "fulfilled") {
          nextStats[normalizeUuid(result.value[0])] = result.value[1];
        }
      }
      setAccountStats(nextStats);
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
          <Button variant="secondary" onClick={syncStats} disabled={syncing}>
            <IconSync size={14} className={syncing ? "spin" : ""} />
            {syncing ? "Синхронизация..." : "Синхр. статистики"}
          </Button>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Игрок</TableHead>
                <TableHead>UUID</TableHead>
                <TableHead>В игре</TableHead>
                <TableHead>Последний вход</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((a) => {
                const uuid = normalizeUuid(a.uuid);
                const isSelf = selfUuid === uuid;
                const stats = accountStats[uuid];
                return (
                  <TableRow
                    key={a.uuid}
                    className="clickable-row account-row"
                    onClick={() => setSelectedAccount(a)}
                  >
                    <TableCell>
                      <div className="cell-main">
                        <SkinHead
                          uuid={a.uuid}
                          username={a.username}
                          size={32}
                        />
                        <strong>{a.username}</strong>
                        {isSelf && <Badge variant="outline">вы</Badge>}
                        {a.banned && (
                          <Badge
                            variant="destructive"
                            title={a.banReason || undefined}
                          >
                            бан
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="mono muted" data-label="UUID">
                      {a.uuid}
                    </TableCell>
                    <TableCell data-label="В игре">
                      <span className="account-stat-value">{formatPlaytime(stats?.playtimeSeconds)}</span>
                    </TableCell>
                    <TableCell data-label="Последний вход">
                      <span className="account-stat-value">{formatLastJoin(stats?.lastJoinedAt)}</span>
                    </TableCell>
                    <TableCell>
                      <span className="row-arrow">→</span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
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
