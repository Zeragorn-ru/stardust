// Сезоны: список, активный сезон, фоновая архивация.

import { useCallback, useState } from "react";
import { api } from "../api";
import { useAsyncData } from "../ui/useAsyncData";
import {
  Button,
  Chip,
  EmptyState,
  PageHeader,
  PageState,
  Panel,
  ProgressBar,
  Table,
} from "../ui/components";
import { useToast } from "../ui/feedback";
import { formatDateTime } from "../format";

export function SeasonsPage() {
  const toast = useToast();
  const fetcher = useCallback(
    () => Promise.all([api.getSeasons(), api.getSeasonArchiveStatus()]),
    [],
  );
  const { data, loading, error, reload } = useAsyncData(fetcher, { pollMs: 20000 });
  const [busy, setBusy] = useState(false);

  async function archive() {
    setBusy(true);
    try {
      const res = await api.archiveSeason();
      toast.success(res.inProgress ? "Архивация запущена" : "Сезон завершён");
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось завершить сезон");
    } finally {
      setBusy(false);
    }
  }

  const seasons = data?.[0] ?? [];
  const status = data?.[1];
  const active = seasons.find((s) => s.status === "active");

  return (
    <div className="page-stack">
      <PageHeader
        title="Сезоны"
        actions={
          <Button variant="primary" busy={busy} disabled={!active} onClick={archive}>
            Завершить текущий сезон
          </Button>
        }
      />

      {status && status.state === "running" && (
        <Panel title="Архивация выполняется">
          <div className="page-stack">
            <div className="row">
              <Chip tone="info">{status.phase}</Chip>
              {status.seasonName && <span className="muted">{status.seasonName}</span>}
            </div>
            <ProgressBar value={0.5} tone="info" />
            <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
              Статистика игроков снимается, счётчики сбрасываются, открывается новый сезон.
            </span>
          </div>
        </Panel>
      )}
      {status && status.state === "error" && (
        <div className="error-panel">
          Ошибка архивации: {status.error ?? "неизвестная"}
        </div>
      )}

      <PageState loading={loading} error={error} onRetry={reload}>
        <Panel flush>
          <Table
            columns={[
              { key: "name", label: "Сезон" },
              { key: "status", label: "Статус", width: "130px" },
              { key: "started", label: "Начало", width: "170px" },
              { key: "ended", label: "Конец", width: "170px" },
              { key: "players", label: "Игроков", width: "110px", align: "right" },
            ]}
            empty={
              <EmptyState
                title="Сезонов нет"
                body="Первый сезон появится автоматически при запуске сервера."
              />
            }
            rows={seasons.map((season) => ({
              key: String(season.id),
              cells: {
                name: season.name,
                status: season.status === "active" ? <Chip tone="accent">активный</Chip> : <Chip>архив</Chip>,
                started: season.startedAt ? formatDateTime(season.startedAt) : "—",
                ended: season.endedAt ? formatDateTime(season.endedAt) : "—",
                players: season.accountsCount ?? "—",
              },
            }))}
          />
        </Panel>
      </PageState>
    </div>
  );
}

export default SeasonsPage;
