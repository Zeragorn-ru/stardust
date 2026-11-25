// Релизы лаунчера: GitHub-релизы, каналы beta/stable, CI-прогоны, promote.

import { useCallback, useState } from "react";
import { api } from "../api";
import type { BuildRun, LauncherRelease } from "../types";
import { useAsyncData } from "../ui/useAsyncData";
import {
  Button,
  Chip,
  EmptyState,
  IconButton,
  PageHeader,
  Panel,
  ProgressBar,
  Select,
  Table,
} from "../ui/components";
import { useToast } from "../ui/feedback";
import { formatDateTime } from "../format";
import { IconRefresh } from "../ui/icons";

const LEG_LABELS: Record<string, string> = {
  windows: "Windows",
  linux: "Linux",
  macos: "macOS",
};

export function ReleasesPage() {
  const toast = useToast();
  const fetcher = useCallback(
    () =>
      Promise.all([
        api.getReleases(),
        api.getLauncherChannels(),
        api.getBuildRuns(),
        api.getPromoteStatus(),
        api.getSetLatestStatus(),
      ]),
    [],
  );
  const { data, reload } = useAsyncData(fetcher, { pollMs: 20000 });
  const [busyTag, setBusyTag] = useState<string | null>(null);

  const [releases, channels, runs, promote, setLatest] = data ?? [[], [], [], null, null];
  const anyBusy = promote?.state === "running" || setLatest?.state === "running";

  async function promoteRelease(release: LauncherRelease) {
    setBusyTag(release.tag);
    try {
      await api.promoteRelease(release.tag);
      toast.success(`Перевод ${release.tag} в stable запущен`);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось запустить перевод");
    } finally {
      setBusyTag(null);
    }
  }

  async function setLatestTag(tag: string, channel: string) {
    setBusyTag(tag + channel);
    try {
      await api.setLatest(tag, channel);
      toast.success(`Канал ${channel} → ${tag}: задача запущена`);
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось переключить канал");
    } finally {
      setBusyTag(null);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="Релизы лаунчера"
        actions={
          <IconButton label="Обновить" onClick={reload}>
            <IconRefresh size={16} />
          </IconButton>
        }
      />

      {anyBusy && (
        <Panel title="Фоновая задача выполняется">
          <ProgressBar value={0.5} tone="info" />
          <p className="muted" style={{ marginTop: "var(--s2)", fontSize: "var(--fs-sm)" }}>
            {promote?.state === "running" ? `Перевод ${promote.tag} в stable` : ""}{" "}
            {setLatest?.state === "running" ? `Переключение канала ${setLatest.channel} → ${setLatest.tag}` : ""}
          </p>
        </Panel>
      )}

      <Panel
        flush
        title="Каналы обновлений"
        description="Какой релиз раздаёт апдейтер каждому каналу."
      >
        <Table
          columns={[
            { key: "channel", label: "Канал", width: "140px" },
            { key: "tag", label: "Раздаёт тег" },
            { key: "updated", label: "Обновлён", width: "170px" },
            { key: "switch", label: "Переключить на", width: "260px", align: "right" },
          ]}
          rows={channels.map((channel) => {
            const candidates = releases.filter((r) =>
              channel.channel === "beta" ? r.prerelease || !r.prerelease : !r.prerelease,
            );
            return {
              key: channel.channel,
              cells: {
                channel: <Chip tone={channel.channel === "stable" ? "ok" : "info"}>{channel.channel}</Chip>,
                tag: channel.tag ? <span className="mono">{channel.tag}</span> : <span className="faint">не настроен</span>,
                updated: channel.updatedAt ? formatDateTime(channel.updatedAt) : "—",
                switch: (
                  <span className="row" style={{ justifyContent: "flex-end" }}>
                    <Select
                      aria-label={`Тег для канала ${channel.channel}`}
                      value=""
                      onChange={(e) => e.target.value && void setLatestTag(e.target.value, channel.channel)}
                      style={{ width: "180px" }}
                    >
                      <option value="">Выбрать тег…</option>
                      {candidates.slice(0, 10).map((r) => (
                        <option key={r.tag} value={r.tag}>
                          {r.tag}
                        </option>
                      ))}
                    </Select>
                  </span>
                ),
              },
            };
          })}
        />
      </Panel>

      <Panel
        flush
        title="Релизы GitHub"
        description="Теги vX.Y.Z. Pre-release переводятся в stable вручную."
      >
        <Table
          columns={[
            { key: "tag", label: "Тег" },
            { key: "name", label: "Название" },
            { key: "kind", label: "Тип", width: "130px" },
            { key: "date", label: "Опубликован", width: "170px" },
            { key: "actions", label: "", width: "160px", align: "right" },
          ]}
          empty={
            <EmptyState
              title="Релизов нет"
              body="Создайте тег vX.Y.Z — GitHub Actions соберёт установщики автоматически."
            />
          }
          rows={releases.map((release) => ({
            key: release.tag,
            cells: {
              tag: <span className="mono">{release.tag}</span>,
              name: release.name ?? <span className="faint">—</span>,
              kind: release.prerelease ? <Chip tone="info">pre-release</Chip> : <Chip tone="ok">stable</Chip>,
              date: release.publishedAt ? formatDateTime(release.publishedAt) : "—",
              actions: (
                <span className="row" style={{ justifyContent: "flex-end" }}>
                  {release.prerelease && (
                    <Button
                      size="sm"
                      busy={busyTag === release.tag || promote?.state === "running"}
                      onClick={() => void promoteRelease(release)}
                    >
                      В stable
                    </Button>
                  )}
                </span>
              ),
            },
          }))}
        />
      </Panel>

      {(runs ?? []).length > 0 && (
        <Panel flush title="Сборки в GitHub Actions" description="Теги, которые ещё собираются или упали.">
          <Table
            columns={[
              { key: "tag", label: "Тег" },
              { key: "legs", label: "Платформы" },
              { key: "date", label: "Начало", width: "170px" },
            ]}
            rows={(runs as BuildRun[]).map((run) => ({
              key: String(run.runId),
              cells: {
                tag: <span className="mono">{run.tag}</span>,
                legs: (
                  <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    {run.legs.map((leg) => (
                      <Chip
                        key={leg.platform}
                        tone={
                          leg.state === "success" ? "ok"
                            : leg.state === "failure" ? "err"
                              : leg.state === "running" || leg.state === "queued" ? "info"
                                : "neutral"
                        }
                      >
                        {LEG_LABELS[leg.platform] ?? leg.platform}: {leg.state}
                      </Chip>
                    ))}
                  </span>
                ),
                date: run.startedAt ? formatDateTime(run.startedAt) : "—",
              },
            }))}
          />
        </Panel>
      )}
    </div>
  );
}

export default ReleasesPage;
