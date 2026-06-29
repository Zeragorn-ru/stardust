import { useState } from "react";
import { api, ApiError } from "../api";
import type { BuildCheckResult, DepsCheckResult } from "../types";
import { useToast } from "../ui/feedback";
import { IconBox } from "../ui/icons";

export function BuildCheckView() {
  const toast = useToast();
  const [fileResult, setFileResult] = useState<BuildCheckResult | null>(null);
  const [depsResult, setDepsResult] = useState<DepsCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkingDeps, setCheckingDeps] = useState(false);

  async function runFileCheck() {
    setChecking(true);
    setFileResult(null);
    try {
      const r = await api.buildCheck();
      setFileResult(r);
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

  async function runDepsCheck() {
    setCheckingDeps(true);
    setDepsResult(null);
    try {
      const r = await api.depsCheck();
      setDepsResult(r);
      if (r.problems.length === 0) {
        toast.success(`Все зависимости ${r.totalMods} модов выполнены`);
      } else {
        toast.error(`Невыполненных зависимостей: ${r.problems.length}`);
      }
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : "Не удалось проверить зависимости",
      );
    } finally {
      setCheckingDeps(false);
    }
  }

  return (
    <section>
      <h2>
        <IconBox /> Проверка сборки
      </h2>

      {/* Файлы */}
      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Файлы на диске</h3>
        <p className="muted" style={{ marginBottom: 12 }}>
          Проверяет что все файлы сборки лежат в <code>modpack-data</code> и их
          размер совпадает.
        </p>
        <button
          className="btn btn--primary"
          onClick={runFileCheck}
          disabled={checking}
        >
          {checking ? "Проверка…" : "Проверить файлы"}
        </button>
        {fileResult && (
          <div style={{ marginTop: 12 }}>
            <p className="muted">
              Файлов: {fileResult.totalFiles} · Проблем:{" "}
              {fileResult.problems.length}
            </p>
            {fileResult.problems.length > 0 && (
              <table className="table" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>Путь</th>
                    <th>Проблема</th>
                    <th>SHA-1</th>
                  </tr>
                </thead>
                <tbody>
                  {fileResult.problems.map((p) => (
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
            )}
          </div>
        )}
      </div>

      {/* Зависимости */}
      <div className="card">
        <h3>Зависимости модов</h3>
        <p className="muted" style={{ marginBottom: 12 }}>
          Читает <code>neoforge.mods.toml</code> из каждого JAR и проверяет что
          все <code>type = "required"</code> зависимости выполнены.
        </p>
        <button
          className="btn btn--primary"
          onClick={runDepsCheck}
          disabled={checkingDeps}
        >
          {checkingDeps ? "Проверка…" : "Проверить зависимости"}
        </button>
        {depsResult && (
          <div style={{ marginTop: 12 }}>
            <p className="muted">
              Модов: {depsResult.totalMods} · Невыполненных зависимостей:{" "}
              {depsResult.problems.length}
            </p>
            {depsResult.problems.length > 0 && (
              <table className="table" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>Мод</th>
                    <th>Требуется</th>
                    <th>Версия</th>
                  </tr>
                </thead>
                <tbody>
                  {depsResult.problems.map((p) => (
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
            )}
          </div>
        )}
      </div>
    </section>
  );
}
