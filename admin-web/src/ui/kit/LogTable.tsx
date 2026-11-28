// LogTable — компактная таблица событий сервера: время, тип, игрок, описание.

import { formatDateTime } from "../../format";

export type LogRowState = "ok" | "warn" | "bad" | "muted";

export interface LogRow {
  /** RFC 3339 время события. */
  time: string;
  type: string;
  player?: string;
  summary: string;
  state?: LogRowState;
}

export interface LogTableProps {
  rows: LogRow[];
}

export function LogTable({ rows }: LogTableProps) {
  if (rows.length === 0) {
    return <div className="kit-card-empty">Событий пока нет</div>;
  }

  return (
    <table className="kit-logtable">
      <thead>
        <tr>
          <th>Время</th>
          <th>Тип</th>
          <th>Игрок</th>
          <th>Событие</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.time}-${index}`}>
            <td className="kit-logtable-time">{formatDateTime(row.time)}</td>
            <td className={`kit-logtable-type kit-logtable--${row.state ?? "muted"}`}>{row.type}</td>
            <td className="kit-logtable-player">{row.player ?? "—"}</td>
            <td className="kit-logtable-summary">{row.summary}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
