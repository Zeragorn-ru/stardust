import { useCallback, useMemo, useState } from "react";
import { api } from "../api";
import type { Account } from "../types";
import { useAsyncData } from "../ui/useAsyncData";
import {
  Chip,
  EllipsisCell,
  EmptyState,
  PageHeader,
  PageState,
  Panel,
  SearchInput,
  Table,
} from "../ui/components";
import { SkinHead } from "../ui/SkinHead";
import { PlayerCard } from "../ui/PlayerCard";

export function AccountsPage() {
  const fetcher = useCallback(() => api.listAccounts(), []);
  const { data, loading, error, reload } = useAsyncData(fetcher);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "admin" | "banned" | "telegram">("all");
  const [card, setCard] = useState<Account | null>(null);

  const accounts = data ?? [];
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return accounts.filter((a) => {
      if (q && !a.username.toLowerCase().includes(q)) return false;
      if (filter === "admin" && !a.isAdmin) return false;
      if (filter === "banned" && !a.banned) return false;
      if (filter === "telegram" && !a.telegramLinked) return false;
      return true;
    });
  }, [accounts, query, filter]);

  return (
    <div className="page-stack">
      <PageHeader title="Аккаунты" />

      <PageState loading={loading} error={error} onRetry={reload}>
        <Panel flush>
          <div className="files-toolbar">
            <SearchInput
              value={query}
              onValueChange={setQuery}
              placeholder="Поиск по нику…"
              style={{ width: "260px" }}
            />
            <span className="spacer" />
            {/* Фильтры как чипы — быстрое переключение */}
            <div className="chip-filters">
              <button
                type="button"
                className={`chip-filter${filter === "all" ? " active" : ""}`}
                onClick={() => setFilter("all")}
              >
                Все
              </button>
              <button
                type="button"
                className={`chip-filter${filter === "admin" ? " active" : ""}`}
                onClick={() => setFilter("admin")}
              >
                Админы
              </button>
              <button
                type="button"
                className={`chip-filter${filter === "banned" ? " active" : ""}`}
                onClick={() => setFilter("banned")}
              >
                Забаненные
              </button>
              <button
                type="button"
                className={`chip-filter${filter === "telegram" ? " active" : ""}`}
                onClick={() => setFilter("telegram")}
              >
                Telegram
              </button>
              <Chip>{visible.length} из {accounts.length}</Chip>
            </div>
          </div>

          <Table
            columns={[
              { key: "name", label: "Ник" },
              { key: "role", label: "Роль", width: "110px" },
              { key: "telegram", label: "Telegram", width: "120px" },
              { key: "status", label: "Статус", width: "130px" },
            ]}
            empty={
              <EmptyState
                title="Аккаунтов не найдено"
                body={accounts.length === 0 ? "Пока никто не зарегистрировался." : "Смягчите фильтры поиска."}
              />
            }
            rows={visible.map((account) => ({
              key: account.uuid,
              clickable: true,
              onClick: () => setCard(account),
              cells: {
                name: (
                  <div className="row">
                    <SkinHead uuid={account.uuid} username={account.username} size={28} />
                    <EllipsisCell text={account.username} />
                  </div>
                ),
                role: account.isAdmin ? <Chip tone="accent">админ</Chip> : <Chip>игрок</Chip>,
                telegram: account.telegramLinked ? <Chip tone="ok">привязан</Chip> : <span className="faint">—</span>,
                status: account.banned ? (
                  <Chip tone="err" title={account.banReason}>
                    забанен{account.bannedUntil ? " (временно)" : ""}
                  </Chip>
                ) : (
                  <Chip tone="ok">активен</Chip>
                ),
              },
            }))}
          />
        </Panel>
      </PageState>

      {card && (
        <PlayerCard
          account={card}
          onClose={() => setCard(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}

export default AccountsPage;
