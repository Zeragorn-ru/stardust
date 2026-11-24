import McText from "./McText";

/**
 * Тело AI-вердикта для игрока: сначала «что сделать», потом причина и
 * технические подробности — под раскрывающимися блоками. Один компонент на
 * всплывашку и историю крашей, чтобы порядок и формулировки не разъезжались.
 */

/** Подписи серьёзности — общие для всплывашки и истории. */
export const SEVERITY_LABELS: Record<string, string> = {
  low: "низкая",
  medium: "средняя",
  high: "высокая",
  critical: "критическая",
};

/**
 * Действия из `suggestion`: сервер кладёт по шагу на строку, старые вердикты
 * могли прийти одной строкой через «; ». Режем и по строкам, и по «; » —
 * иначе длинный старый ответ останется простынёй.
 */
export function splitActions(suggestion: string | null | undefined): string[] {
  return (suggestion ?? "")
    .split(/\n|;\s*/)
    .map((line) => line.replace(/^\s*(?:[-*•–]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

/** Обрезка старых длинных вердиктов (новые сервер уже ограничивает). */
function limit(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("").trimEnd()}…`;
}

export default function CrashVerdictBody({
  summary,
  cause,
  suggestion,
  rawReport,
  rawError,
}: {
  summary?: string | null;
  cause?: string | null;
  suggestion?: string | null;
  /** Сырая сводка краша — «Отчёт» из лаунчера, для любопытных технарей. */
  rawReport?: string | null;
  /** Ошибка AI-провайдера при неудачном разборе. */
  rawError?: string | null;
}) {
  const actions = splitActions(suggestion).map((action) => limit(action, 160));

  return (
    <>
      {summary && (
        <p className="crash-verdict__summary">
          <McText text={limit(summary, 220)} />
        </p>
      )}
      {actions.length > 0 && (
        <div className="crash-verdict__steps">
          <span className="crash-verdict__label">Что сделать</span>
          <ol>
            {actions.map((action, index) => (
              <li key={index}><McText text={action} /></li>
            ))}
          </ol>
        </div>
      )}
      {cause && (
        <details className="crash-verdict__more">
          <summary>Почему так</summary>
          <p><McText text={limit(cause, 200)} /></p>
        </details>
      )}
      {rawReport && rawReport !== summary && (
        <details className="crash-verdict__more">
          <summary>Технические подробности</summary>
          <p><McText text={rawReport} /></p>
        </details>
      )}
      {rawError && (
        <details className="crash-verdict__more">
          <summary>Технические подробности</summary>
          <p>{rawError}</p>
        </details>
      )}
    </>
  );
}
