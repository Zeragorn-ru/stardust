// Логи сервера: журнал событий, детали, AI-анализ крашей.

import { useCallback, useState } from "react";
import { api } from "../api";
import type { ServerLogEntry, ServerLogSummary } from "../types";
import { useAsyncData } from "../ui/useAsyncData";
import {
  Button,
  Chip,
  EmptyState,
  Modal,
  PageHeader,
  PageState,
  Panel,
  Table,
} from "../ui/components";
import { useToast } from "../ui/feedback";
import { formatDateTime } from "../format";
import { SafeHtml } from "../ui/SafeHtml";

const TYPE_LABELS: Record<string, { label: string; tone: "ok" | "err" | "warn" | "info" | "neutral" }> = {
  join: { label: "вход", tone: "ok" },
  quit: { label: "выход", tone: "neutral" },
  client_crash: { label: "краш клиента", tone: "err" },
  server_crash: { label: "краш сервера", tone: "err" },
  external_mods: { label: "внешние моды", tone: "warn" },
};

export function LogsPage() {
  const fetcher = useCallback(() => api.getServerLogs(), []);
  const { data, loading, error, reload } = useAsyncData(fetcher, { pollMs: 30000 });
  const [detail, setDetail] = useState<ServerLogEntry | null>(null);

  async function open(log: ServerLogSummary) {
    try {
      setDetail(await api.getServerLog(log.id));
    } catch (err) {
      setDetail({ ...log, details: {} });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader title="Логи сервера" />
      <PageState loading={loading} error={error} onRetry={reload}>
        <Panel flush>
          <Table
            columns={[
              { key: "time", label: "Время", width: "140px" },
              { key: "type", label: "Событие", width: "150px" },
              { key: "user", label: "Игрок", width: "160px" },
              { key: "summary", label: "Описание" },
              { key: "ai", label: "AI", width: "70px", align: "center" },
            ]}
            empty={
              <EmptyState
                title="Событий нет"
                body="Журнал наполнится, как только сервер начнёт присылать телеметрию."
              />
            }
            rows={(data?.logs ?? []).map((log) => {
              const meta = TYPE_LABELS[log.eventType] ?? { label: log.eventType, tone: "neutral" as const };
              return {
                key: String(log.id),
                cells: {
                  time: <span className="mono faint">{formatDateTime(log.recordedAt)}</span>,
                  type: <Chip tone={meta.tone}>{meta.label}</Chip>,
                  user: log.username ?? <span className="faint">—</span>,
                  summary: (
                    <button type="button" className="linklike ellipsis" style={{ display: "block", maxWidth: "100%" }} onClick={() => void open(log)}>
                      {log.summary}
                    </button>
                  ),
                  ai: log.eventType.includes("crash") ? (
                    <Chip tone="info">AI</Chip>
                  ) : (
                    <span className="faint">—</span>
                  ),
                },
              };
            })}
          />
        </Panel>
      </PageState>

      {detail && (
        <LogDetailModal
          entry={detail}
          onClose={() => setDetail(null)}
          onChanged={(updated) => setDetail(updated)}
        />
      )}
    </div>
  );
}

function LogDetailModal({
  entry,
  onClose,
  onChanged,
}: {
  entry: ServerLogEntry;
  onClose: () => void;
  onChanged: (entry: ServerLogEntry) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const isCrash = entry.eventType.includes("crash");
  const meta = TYPE_LABELS[entry.eventType] ?? { label: entry.eventType, tone: "neutral" as const };

  async function analyze() {
    setBusy(true);
    try {
      const result = await api.analyzeServerLog(entry.id);
      onChanged({ ...entry, aiStatus: "done", aiAnalysis: result });
      toast.success("Анализ готов");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Анализ не удался");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Детали события" size="lg" onClose={onClose}>
      <div className="page-stack">
        <div className="row">
          <Chip tone={meta.tone}>{meta.label}</Chip>
          <span className="muted mono">{formatDateTime(entry.recordedAt)}</span>
          {entry.username && <Chip>{entry.username}</Chip>}
        </div>
        <p>{entry.summary}</p>

        {Object.keys(entry.details).length > 0 && (
          <Panel title="Технические детали" flush>
            <div style={{ padding: "var(--s3)" }}>
              {Object.entries(entry.details).map(([key, value]) => (
                <div key={key} className="log-details" style={{ marginBottom: "var(--s2)" }}>
                  <span className="mono faint">{key}</span>
                  <span className="mono ellipsis" title={String(value)}>
                    {typeof value === "string" && /</.test(value) ? <SafeHtml html={value} /> : String(value)}
                  </span>
                </div>
              ))}
            </div>
          </Panel>
        )}

        {isCrash && (
          <Panel
            title="AI-анализ краша"
            description="Диагностика через настроенного AI-провайдера."
            actions={
              <Button size="sm" busy={busy} onClick={analyze}>
                {(entry.aiStatus === "done" || entry.aiStatus === "failed") ? "Перепроверить" : "Анализировать"}
              </Button>
            }
          >
            {entry.aiStatus === "done" && entry.aiAnalysis ? (
              <div className="page-stack">
                {entry.aiAnalysis.summary && <p><strong>Резюме:</strong> {entry.aiAnalysis.summary}</p>}
                {entry.aiAnalysis.cause && <p><strong>Причина:</strong> {entry.aiAnalysis.cause}</p>}
                {entry.aiAnalysis.suggestion && <p><strong>Рекомендация:</strong> {entry.aiAnalysis.suggestion}</p>}
                <div className="row">
                  {entry.aiAnalysis.severity && (
                    <Chip tone={entry.aiAnalysis.severity === "critical" || entry.aiAnalysis.severity === "high" ? "err" : "warn"}>
                      серьёзность: {entry.aiAnalysis.severity}
                    </Chip>
                  )}
                  {entry.aiAnalysis.model && <span className="faint mono">{entry.aiAnalysis.model}</span>}
                </div>
              </div>
            ) : entry.aiStatus === "failed" ? (
              <p className="text-err">Анализ не удался: {entry.aiAnalysis?.error ?? "неизвестная ошибка"}</p>
            ) : (
              <p className="muted">Ещё не анализировался.</p>
            )}
          </Panel>
        )}
      </div>
    </Modal>
  );
}

export default LogsPage;
