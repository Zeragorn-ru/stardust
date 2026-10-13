import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Account, PlayerStats } from "../types";
import { useToast } from "../ui/feedback";
import { IconCopy, IconSearch, IconSync } from "../ui/icons";
import { PlayerCardModal } from "../ui/PlayerCardModal";
import { EmptyPanel, ErrorPanel, LoadPanel } from "../ui/EmptyState";
import { formatDateTime, formatPlaytime } from "../format";
import { Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/shadcn";

function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

function formatLastJoin(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return formatDateTime(iso, { day: "2-digit", month: "2-digit" });
}

async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}

type RoleFilter = "all" | "admin" | "user";
type StatusFilter = "all" | "active" | "banned";
type TelegramFilter = "all" | "linked" | "unlinked";
type ActivityFilter = "all" | "joined" | "never";
type AccountSort = "username" | "role" | "playtime" | "lastJoined";

type AccountFilterPreferences = {
  query: string;
  roleFilter: RoleFilter;
  statusFilter: StatusFilter;
  telegramFilter: TelegramFilter;
  activityFilter: ActivityFilter;
  sortBy: AccountSort;
};

const ACCOUNT_FILTERS_STORAGE_KEY = "stardust.admin.accounts.filters";

function isRoleFilter(value: unknown): value is RoleFilter {
  return value === "all" || value === "admin" || value === "user";
}

function isStatusFilter(value: unknown): value is StatusFilter {
  return value === "all" || value === "active" || value === "banned";
}

function isTelegramFilter(value: unknown): value is TelegramFilter {
  return value === "all" || value === "linked" || value === "unlinked";
}

function isActivityFilter(value: unknown): value is ActivityFilter {
  return value === "all" || value === "joined" || value === "never";
}

function isAccountSort(value: unknown): value is AccountSort {
  return value === "username" || value === "role" || value === "playtime" || value === "lastJoined";
}

function readAccountFilterPreferences(): Partial<AccountFilterPreferences> {
  try {
    const raw = localStorage.getItem(ACCOUNT_FILTERS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      query: typeof parsed.query === "string" ? parsed.query : undefined,
      roleFilter: isRoleFilter(parsed.roleFilter) ? parsed.roleFilter : undefined,
      statusFilter: isStatusFilter(parsed.statusFilter) ? parsed.statusFilter : undefined,
      telegramFilter: isTelegramFilter(parsed.telegramFilter) ? parsed.telegramFilter : undefined,
      activityFilter: isActivityFilter(parsed.activityFilter) ? parsed.activityFilter : undefined,
      sortBy: isAccountSort(parsed.sortBy) ? parsed.sortBy : undefined,
    };
  } catch {
    return {};
  }
}

const ROLE_LABELS: Record<RoleFilter, string> = {
  all: "Все",
  admin: "Админы",
  user: "Игроки",
};

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: "Все",
  active: "Активные",
  banned: "В бане",
};

const TELEGRAM_LABELS: Record<TelegramFilter, string> = {
  all: "Все",
  linked: "Привязан",
  unlinked: "Не привязан",
};

const ACTIVITY_LABELS: Record<ActivityFilter, string> = {
  all: "Все",
  joined: "Заходили",
  never: "Без входов",
};

const SORT_LABELS: Record<AccountSort, string> = {
  username: "По имени",
  role: "Админы сверху",
  playtime: "По времени в игре",
  lastJoined: "По последнему входу",
};

export function AccountsView() {
  const toast = useToast();
  const initialFilters = useMemo(() => readAccountFilterPreferences(), []);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState(initialFilters.query ?? "");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>(initialFilters.roleFilter ?? "all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialFilters.statusFilter ?? "all");
  const [telegramFilter, setTelegramFilter] = useState<TelegramFilter>(initialFilters.telegramFilter ?? "all");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(initialFilters.activityFilter ?? "all");
  const [sortBy, setSortBy] = useState<AccountSort>(initialFilters.sortBy ?? "username");
  const [selfUuid, setSelfUuid] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [accountStats, setAccountStats] = useState<Record<string, PlayerStats>>({});
  const [statsErrorCount, setStatsErrorCount] = useState(0);

  async function syncStats() {
    setSyncing(true);
    try {
      const res = await api.syncStats();
      toast.success(`Статистика обновлена: ${res.updated} игроков`);
      // Подтягиваем свежие значения, иначе таблица останется устаревшей
      // до перезахода на экран.
      await load();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Ошибка синхронизации",
      );
    } finally {
      setSyncing(false);
    }
  }

  // Двухфазная загрузка (план 3.3): список аккаунтов рендерится сразу,
  // статистика каждого догружается в фоне (ячейки «…» до её прихода).
  // TODO: batched-эндпоинт статистики одним запросом — вне скоупа UI-плана.
  const firstLoadDone = useRef(false);
  const load = useCallback(async () => {
    // Повторный вызов (после сбоя, кнопкой «Повторить» или после
    // синхронизации) — это фоновой рефреш, экран уже отрисован.
    if (firstLoadDone.current) setRefreshing(true);
    try {
      const nextAccounts = await api.listAccounts();
      setAccounts(nextAccounts);
      setListError(null);
      setLoading(false);
      firstLoadDone.current = true;

      setStatsErrorCount(0);
      await Promise.all(
        nextAccounts.map(async (account) => {
          try {
            const stats = await api.getAccountStats(account.uuid);
            setAccountStats((cur) => ({
              ...cur,
              [normalizeUuid(account.uuid)]: stats,
            }));
          } catch {
            setStatsErrorCount((cur) => cur + 1);
          }
        }),
      );
    } catch (err) {
      // Сбой загрузки списка — это не «Аккаунтов пока нет» (план 3.3):
      // показываем ErrorPanel с причиной и «Повторить».
      setListError(err instanceof ApiError ? err.message : "Не удалось загрузить аккаунты");
      setLoading(false);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    try {
      localStorage.setItem(ACCOUNT_FILTERS_STORAGE_KEY, JSON.stringify({
        query,
        roleFilter,
        statusFilter,
        telegramFilter,
        activityFilter,
        sortBy,
      }));
    } catch {
      return;
    }
  }, [activityFilter, query, roleFilter, sortBy, statusFilter, telegramFilter]);

  // Свой UUID — чтобы не предлагать снять с себя права/забанить себя.
  useEffect(() => {
    api
      .me()
      .then((me) => setSelfUuid(normalizeUuid(me.uuid)))
      .catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = accounts.filter((account) => {
      const uuid = normalizeUuid(account.uuid);
      const stats = accountStats[uuid];
      const matchesQuery = q
        ? account.username.toLowerCase().includes(q) || uuid.includes(q) || account.uuid.toLowerCase().includes(q)
        : true;
      const matchesRole = roleFilter === "all" || (roleFilter === "admin" ? account.isAdmin : !account.isAdmin);
      const matchesStatus = statusFilter === "all" || (statusFilter === "banned" ? account.banned : !account.banned);
      const matchesTelegram = telegramFilter === "all" || (telegramFilter === "linked" ? account.telegramLinked : !account.telegramLinked);
      const matchesActivity = activityFilter === "all" || (activityFilter === "joined" ? Boolean(stats?.lastJoinedAt) : !stats?.lastJoinedAt);
      return matchesQuery && matchesRole && matchesStatus && matchesTelegram && matchesActivity;
    });

    return [...list].sort((a, b) => {
      const statsA = accountStats[normalizeUuid(a.uuid)];
      const statsB = accountStats[normalizeUuid(b.uuid)];
      if (sortBy === "role" && a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
      if (sortBy === "playtime") return (statsB?.playtimeSeconds ?? -1) - (statsA?.playtimeSeconds ?? -1);
      if (sortBy === "lastJoined") {
        const timeA = statsA?.lastJoinedAt ? new Date(statsA.lastJoinedAt).getTime() : 0;
        const timeB = statsB?.lastJoinedAt ? new Date(statsB.lastJoinedAt).getTime() : 0;
        if (timeA !== timeB) return timeB - timeA;
      }
      if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
      return a.username.localeCompare(b.username);
    });
  }, [accounts, accountStats, activityFilter, query, roleFilter, sortBy, statusFilter, telegramFilter]);

  const adminCount = accounts.filter((a) => a.isAdmin).length;
  const bannedCount = accounts.filter((a) => a.banned).length;
  // Чипы показываем для всего, что реально влияет на выборку: сортировка
  // состав меняет, но показывает порядок — тоже видимая настройка.
  const filtersActive = Boolean(query.trim()) || roleFilter !== "all" || statusFilter !== "all" || telegramFilter !== "all" || activityFilter !== "all" || sortBy !== "username";

  function resetFilters() {
    setQuery("");
    setRoleFilter("all");
    setStatusFilter("all");
    setTelegramFilter("all");
    setActivityFilter("all");
    setSortBy("username");
  }

  function resetQuery() {
    setQuery("");
  }

  function resetRole() {
    setRoleFilter("all");
  }

  function resetStatus() {
    setStatusFilter("all");
  }

  function resetTelegram() {
    setTelegramFilter("all");
  }

  function resetActivity() {
    setActivityFilter("all");
  }

  function resetSort() {
    setSortBy("username");
  }

  return (
    <div className="view accounts-view">
      <header className="view-head page-head">
        <div>
          <span className="eyebrow">Игроки</span>
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

      {/* Активные фильтры всегда видимы над таблицей (план 3.3): раньше
          сохранённое в localStorage состояние было спрятано за свёрнутой
          панелью, и отфильтрованный список выглядел как «Аккаунтов нет».
          Чипы по образцу .fm-chips из FileManager: «×» снимает один
          фильтр, «Сбросить все» — весь набор. */}
      <div className="fm-chips accounts-chips" aria-label="Активные фильтры">
        {query.trim() !== "" && (
          <span className="fm-chip">
            Поиск: {query.trim()}
            <button type="button" className="fm-chip-x" aria-label="Убрать фильтр: поиск" onClick={resetQuery}>×</button>
          </span>
        )}
        {roleFilter !== "all" && (
          <span className="fm-chip">
            Роль: {ROLE_LABELS[roleFilter]}
            <button type="button" className="fm-chip-x" aria-label="Убрать фильтр: роль" onClick={resetRole}>×</button>
          </span>
        )}
        {statusFilter !== "all" && (
          <span className="fm-chip">
            Статус: {STATUS_LABELS[statusFilter]}
            <button type="button" className="fm-chip-x" aria-label="Убрать фильтр: статус" onClick={resetStatus}>×</button>
          </span>
        )}
        {telegramFilter !== "all" && (
          <span className="fm-chip">
            Telegram: {TELEGRAM_LABELS[telegramFilter]}
            <button type="button" className="fm-chip-x" aria-label="Убрать фильтр: Telegram" onClick={resetTelegram}>×</button>
          </span>
        )}
        {activityFilter !== "all" && (
          <span className="fm-chip">
            Активность: {ACTIVITY_LABELS[activityFilter]}
            <button type="button" className="fm-chip-x" aria-label="Убрать фильтр: активность" onClick={resetActivity}>×</button>
          </span>
        )}
        {sortBy !== "username" && (
          <span className="fm-chip">
            Сортировка: {SORT_LABELS[sortBy]}
            <button type="button" className="fm-chip-x" aria-label="Сбросить сортировку" onClick={resetSort}>×</button>
          </span>
        )}
        {filtersActive && (
          <button className="fm-chip fm-chip-reset" type="button" onClick={resetFilters}>
            Сбросить все
          </button>
        )}
      </div>

      <div className="panel panel-flat accounts-filter-panel">
        <div className="filter-summary"><strong>{filtered.length}</strong><span>показано из {accounts.length}</span></div>
        <label>
          Роль
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}>
            <option value="all">Все</option>
            <option value="admin">Админы</option>
            <option value="user">Игроки</option>
          </select>
        </label>
        <label>
          Статус
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
            <option value="all">Все</option>
            <option value="active">Активные</option>
            <option value="banned">В бане</option>
          </select>
        </label>
        <label>
          Telegram
          <select value={telegramFilter} onChange={(e) => setTelegramFilter(e.target.value as TelegramFilter)}>
            <option value="all">Все</option>
            <option value="linked">Привязан</option>
            <option value="unlinked">Не привязан</option>
          </select>
        </label>
        <label>
          Активность
          <select value={activityFilter} onChange={(e) => setActivityFilter(e.target.value as ActivityFilter)}>
            <option value="all">Все</option>
            <option value="joined">Заходили</option>
            <option value="never">Без входов</option>
          </select>
        </label>
        <label>
          Сортировка
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as AccountSort)}>
            <option value="username">По имени</option>
            <option value="role">Админы сверху</option>
            <option value="playtime">По времени в игре</option>
            <option value="lastJoined">По последнему входу</option>
          </select>
        </label>
        <Button variant="ghost" onClick={resetFilters} disabled={!filtersActive}>Сбросить</Button>
      </div>

      {statsErrorCount > 0 && (
        <div className="panel panel-flat account-stats-warning">
          <div>
            <strong>Часть статистики недоступна</strong>
            <span>Не загрузилось: {statsErrorCount}. Фильтр активности и сортировка по времени могут быть неполными.</span>
          </div>
          <Button variant="secondary" onClick={load}>Повторить</Button>
        </div>
      )}

      <div className="panel panel-flat table-panel">
        {loading ? (
          <LoadPanel>Загрузка аккаунтов…</LoadPanel>
        ) : listError ? (
          <ErrorPanel title="Не удалось загрузить аккаунты" onRetry={load} busy={refreshing}>
            {listError}
          </ErrorPanel>
        ) : filtered.length === 0 ? (
          accounts.length === 0 ? (
            <EmptyPanel title="Аккаунтов пока нет">
              Игроки появятся после первой регистрации или входа через лаунчер.
            </EmptyPanel>
          ) : (
            <EmptyPanel title="Ничего не найдено">
              Под текущие фильтры не подходит ни один аккаунт — ослабьте условия или сбросьте фильтры.
            </EmptyPanel>
          )
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
                    tabIndex={0}
                    aria-label={`Открыть аккаунт ${a.username}`}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedAccount(a);
                      }
                    }}
                  >
                    <TableCell>
                      <div className="cell-main">
                        <span className="account-initial" aria-hidden="true">
                          {a.username.slice(0, 1).toUpperCase()}
                        </span>
                        <strong>{a.username}</strong>
                        {isSelf && <Badge variant="outline">вы</Badge>}
                        {a.isAdmin && <Badge variant="success">admin</Badge>}
                        {a.telegramLinked && <Badge variant="secondary">tg</Badge>}
                        {a.banned && (
                          <Badge
                            variant="destructive"
                            title={a.banReason || undefined}
                          >
                            бан{a.banReason ? `: ${a.banReason}` : ""}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="mono muted" data-label="UUID">
                      <span className="copy-cell">
                        <span>{a.uuid}</span>
                        <button
                          type="button"
                          className="icon-only copy-inline"
                          title="Скопировать UUID"
                          aria-label={`Скопировать UUID ${a.username}`}
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              await copyText(a.uuid);
                              toast.success("UUID скопирован");
                            } catch {
                              toast.error("Не удалось скопировать UUID");
                            }
                          }}
                        >
                          <IconCopy size={14} />
                        </button>
                      </span>
                    </TableCell>
                    <TableCell data-label="В игре">
                      <span className="account-stat-value">
                        {stats ? formatPlaytime(stats.playtimeSeconds) : "…"}
                      </span>
                    </TableCell>
                    <TableCell data-label="Последний вход">
                      <span className="account-stat-value">
                        {stats ? formatLastJoin(stats.lastJoinedAt) : "…"}
                      </span>
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
          isSelf={selfUuid !== null && selfUuid === normalizeUuid(selectedAccount.uuid)}
          // Статистика уже загружена таблицей — InfoTab не рефетчит (план 3.3).
          stats={accountStats[normalizeUuid(selectedAccount.uuid)]}
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
