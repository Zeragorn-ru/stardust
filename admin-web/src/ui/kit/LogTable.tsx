// LogTable — компактная таблица событий сервера: время, тип, игрок, описание.
//
// Опциональная колонка действий: если передан renderActions, справа
// добавляется столбец (например, кнопка «Разобрать AI» в журнале событий).
// Идентификатор строки передаётся в поле id — без него действие нельзя
// привязать к записи.

import type { ReactNode } from "react";

import { formatDateTime } from "../../format";

export type LogRowState = "ok" | "warn" | "bad" | "muted";

export interface LogRow {
  /** Стабильный ключ строки (id записи журнала), если известен. */
  id?: number | string;
  /** RFC 3339 время события. */
  time: string;
  type: string;
  player?: string;
  summary: ReactNode;
  state?: LogRowState;
}

export interface LogTableProps {
  rows: LogRow[];
  /** Колбэк отрисовки ячейки действий; колонка появляется только с ним. */
  renderActions?: (row: LogRow, index: number) => ReactNode;
}

export function LogTable({ rows, renderActions }: LogTableProps) {
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
          {renderActions && <th className="kit-logtable-actions-col">Действия</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={row.id ?? `${row.time}-${index}`}>
            <td className="kit-logtable-time">{formatDateTime(row.time)}</td>
            <td className={`kit-logtable-type kit-logtable--${row.state ?? "muted"}`}>{row.type}</td>
            <td className="kit-logtable-player">{row.player ?? "—"}</td>
            <td className="kit-logtable-summary">{row.summary}</td>
            {renderActions && <td className="kit-logtable-actions">{renderActions(row, index)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
