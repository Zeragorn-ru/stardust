// Результаты проверки сборки: файлы на диске + зависимости модов.
// Переиспользуется в десктопном BuildDetail и мобильном MobileBuildDetail.

import type { BuildCheckResult, DepsCheckResult } from "../types";

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
          <table className="table">
            <thead>
              <tr>
                <th>Путь</th>
                <th>Проблема</th>
                <th>SHA-1</th>
              </tr>
            </thead>
            <tbody>
              {build.problems.map((p) => (
                <tr key={p.path + p.kind}>
                  <td className="mono">{p.path}</td>
                  <td>
                    {p.kind === "missing" ? (
                      <span className="tag tag--red">отсутствует</span>
                    ) : (
                      <span className="tag tag--yellow">
                        несовпадение размера
                      </span>
                    )}
                    <br />
                    <span className="muted">{p.detail}</span>
                  </td>
                  <td className="mono muted" style={{ fontSize: 12 }}>
                    {p.sha1}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
          <table className="table">
            <thead>
              <tr>
                <th>Мод</th>
                <th>Требуется</th>
                <th>Версия</th>
              </tr>
            </thead>
            <tbody>
              {deps.problems.map((p) => (
                <tr key={p.fromMod + p.requiredMod}>
                  <td className="mono">{p.fromMod}</td>
                  <td>
                    <span className="tag tag--red">{p.requiredMod}</span>
                  </td>
                  <td className="muted">{p.versionRange}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
