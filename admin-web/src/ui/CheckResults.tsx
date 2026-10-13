// Результаты проверки сборки: файлы на диске + зависимости модов.
// Переиспользуется в десктопном BuildDetail и мобильном MobileBuildDetail.

import type { BuildCheckResult, DepsCheckResult } from "../types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./shadcn";

export interface CheckState {
  build: BuildCheckResult | null;
  deps: DepsCheckResult | null;
  loading: boolean;
}

export function CheckResults({ state }: { state: CheckState }) {
  const { build, deps, loading } = state;

  if (loading) {
    return (
      <div className="check-results muted">
        <span className="spinner" /> Проверка…
      </div>
    );
  }

  if (!build && !deps) return null;

  const totalProblems =
    (build?.problems.length ?? 0) + (deps?.problems.length ?? 0);

  return (
    <div className="check-results">
      {totalProblems === 0 ? (
        <p className="check-ok">Всё в порядке</p>
      ) : (
        <p className="check-summary">
          Найдено проблем: <strong>{totalProblems}</strong>
        </p>
      )}

      {build && build.problems.length > 0 && (
        <div className="check-section">
          <h4>
            Файлы на диске{" "}
            <span className="muted">
              ({build.totalFiles} файлов, {build.problems.length} проблем)
            </span>
          </h4>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Путь</TableHead>
                <TableHead>Проблема</TableHead>
                <TableHead>SHA-1</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {build.problems.map((p) => (
                <TableRow key={p.path + p.kind}>
                  <TableCell className="mono">{p.path}</TableCell>
                  <TableCell>
                    {p.kind === "missing" ? (
                      <span className="tag tag--red">отсутствует</span>
                    ) : (
                      <span className="tag tag--yellow">
                        несовпадение размера
                      </span>
                    )}
                    <br />
                    <span className="muted">{p.detail}</span>
                  </TableCell>
                  <TableCell className="mono muted" style={{ fontSize: 12 }}>
                    {p.sha1}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {build && build.problems.length === 0 && (
        <div className="check-section">
          <span className="tag tag--green" style={{ marginRight: 8 }}>
            Файлы
          </span>
          Все {build.totalFiles} файлов на месте
        </div>
      )}

      {deps && deps.problems.length > 0 && (
        <div className="check-section">
          <h4>
            Зависимости модов{" "}
            <span className="muted">
              ({deps.totalMods} модов, {deps.problems.length} невыполненных)
            </span>
          </h4>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Мод</TableHead>
                <TableHead>Требуется</TableHead>
                <TableHead>Версия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deps.problems.map((p) => (
                <TableRow key={p.fromMod + p.requiredMod}>
                  <TableCell className="mono">{p.fromMod}</TableCell>
                  <TableCell>
                    <span className="tag tag--red">{p.requiredMod}</span>
                  </TableCell>
                  <TableCell className="muted">{p.versionRange}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {deps && deps.problems.length === 0 && (
        <div className="check-section">
          <span className="tag tag--green" style={{ marginRight: 8 }}>
            Зависимости
          </span>
          Все зависимости {deps.totalMods} модов выполнены
        </div>
      )}
    </div>
  );
}
