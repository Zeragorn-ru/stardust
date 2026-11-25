// Аккаунты: поиск, модерация, Telegram, скины, карточка игрока.

import { useCallback, useMemo, useState } from "react";
import { api } from "../api";
import type { Account } from "../types";
import { useAsyncData } from "../ui/useAsyncData";
import {
  Chip,
  EmptyState,
  IconButton,
  PageHeader,
  PageState,
  Panel,
  SearchInput,
  Select,
  Table,
} from "../ui/components";
import { SkinHead } from "../ui/SkinHead";
import { PlayerCard } from "../ui/PlayerCard";
import { IconUsers } from "../ui/icons";

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
            <Select
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
              aria-label="Фильтр"
              style={{ width: "200px" }}
            >
              <option value="all">Все аккаунты</option>
              <option value="admin">Админы</option>
              <option value="banned">Забаненные</option>
              <option value="telegram">С Telegram</option>
            </Select>
            <span className="spacer" />
            <Chip>{visible.length} из {accounts.length}</Chip>
          </div>

          <Table
            columns={[
              { key: "name", label: "Ник" },
              { key: "role", label: "Роль", width: "110px" },
              { key: "telegram", label: "Telegram", width: "120px" },
              { key: "status", label: "Статус", width: "130px" },
              { key: "actions", label: "", width: "120px", align: "right" },
            ]}
            empty={
              <EmptyState
                title="Аккаунтов не найдено"
                body={accounts.length === 0 ? "Пока никто не зарегистрировался." : "Смягчите фильтры поиска."}
              />
            }
            rows={visible.map((account) => ({
              key: account.uuid,
              cells: {
                name: (
                  <button type="button" className="linklike row" onClick={() => setCard(account)}>
                    <SkinHead uuid={account.uuid} username={account.username} size={28} />
                    <EllipsisName name={account.username} />
                  </button>
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
                actions: (
                  <IconButton label="Карточка игрока" size="sm" onClick={() => setCard(account)}>
                    <IconUsers size={14} />
                  </IconButton>
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

function EllipsisName({ name }: { name: string }) {
  return <span className="ellipsis">{name}</span>;
}

export default AccountsPage;
