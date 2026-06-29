import { useState } from "react";
import { api, ApiError } from "../api";
import type { BuildCheckResult } from "../types";
import { useToast } from "../ui/feedback";
import { IconBox } from "../ui/icons";

export function BuildCheckView() {
  const toast = useToast();
  const [result, setResult] = useState<BuildCheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  async function runCheck() {
    setChecking(true);
    setResult(null);
    try {
      const r = await api.buildCheck();
      setResult(r);
      if (r.problems.length === 0) {
        toast.success(`Все ${r.totalFiles} файлов на месте`);
      } else {
        toast.error(`Найдено проблем: ${r.problems.length}`);
      }
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : "Не удалось выполнить проверку",
      );
    } finally {
      setChecking(false);
    }
  }

  return (
    <section>
      <h2>
        <IconBox /> Проверка сборки
      </h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Проверяет что все файлы активной сборки лежат на диске в{" "}
        <code>modpack-data</code> и их размер совпадает с записанным.
      </p>
      <button
        className="btn btn--primary"
        onClick={runCheck}
        disabled={checking}
      >
        {checking ? "Проверка…" : "Проверить"}
      </button>

      {result && (
        <div style={{ marginTop: 24 }}>
          <h3>
            {result.buildName} (#{result.buildId})
          </h3>
          <p className="muted">
            Файлов: {result.totalFiles} · Проблем: {result.problems.length}
          </p>
          {result.problems.length > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Путь</th>
                    <th>Проблема</th>
                    <th>SHA-1</th>
                  </tr>
                </thead>
                <tbody>
                  {result.problems.map((p) => (
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
        </div>
      )}
    </section>
  );
}
