// Безопасный рендер HTML из внешнего источника (описания CurseForge).
//
// HTML приходит от чужого API и содержит всё, что угодно: `<script>`,
// обработчики `onerror`, `javascript:`-ссылки. В админке это особенно
// опасно — токен сессии лежит в localStorage. Поэтому innerHTML не
// используется вообще: HTML парсится в DOMParser (он не исполняет
// скрипты и не грузит картинки), затем разрешённые узлы превращаются в
// React-элементы. Всё, чего нет в allowlist, отбрасывается вместе с
// потомками — React экранирует текст сам.

import type { ReactNode } from "react";

/** Теги, которые допустимы в описании мода. */
const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "strong", "b", "em", "i", "u", "s", "del", "code", "pre",
  "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td", "img", "a", "span", "div",
]);

/** Теги, которые отбрасываются вместе с содержимым. */
const DROP_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input", "button",
  "link", "meta", "base", "svg", "math", "template", "noscript",
]);

/** Атрибуты-allowlist по тегу; всё остальное (включая on*) вырезается. */
const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ["href", "title"],
  img: ["src", "alt", "title", "width", "height"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
};

/** Только http(s): `javascript:` и `data:` в src/href недопустимы. */
function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw, "https://invalid.local/");
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // Относительные ссылки тоже приводим к абсолютным от-заглушки — не
    // пускаем их: описания модов всегда ссылаются наружу.
    if (url.hostname === "invalid.local") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function attrsOf(el: Element): Record<string, string> {
  const allowed = ALLOWED_ATTRS[el.tagName.toLowerCase()] ?? [];
  const out: Record<string, string> = {};
  for (const name of allowed) {
    const value = el.getAttribute(name);
    if (value == null) continue;
    if (name === "href" || name === "src") {
      const safe = safeUrl(value);
      if (safe) out[name] = safe;
    } else if (name === "width" || name === "height" || name === "colspan" || name === "rowspan") {
      if (/^\d{1,5}$/.test(value.trim())) out[name] = value.trim();
    } else {
      out[name] = value;
    }
  }
  return out;
}

/** Void-элементы: children им React передавать нельзя (ошибка #137). */
const VOID_TAGS = new Set(["br", "hr", "img"]);

function convert(node: Node, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue ?? "";
    // Схлопываем пустые/пробельные узлы между блоками: иначе в таблицах
    // и списках появляются лишние пробелы.
    return text;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  if (DROP_TAGS.has(tag) || !ALLOWED_TAGS.has(tag)) {
    // Неизвестный тег — не теряем текст внутри: рендерим детей как есть.
    return <>{Array.from(el.childNodes).map((child, i) => convert(child, `${key}-${i}`))}</>;
  }

  const attrs = attrsOf(el);
  const isLink = tag === "a" && attrs.href;
  const props: Record<string, unknown> = { ...attrs };
  if (isLink) {
    props.target = "_blank";
    props.rel = "noopener noreferrer";
  }
  // React не любит произвольные теги в обобщённом виде — диспетчеризация
  // по allowlist выше гарантирует, что это валидный HTML-тег.
  const Tag = tag as keyof JSX.IntrinsicElements;
  if (VOID_TAGS.has(tag)) {
    return <Tag key={key} {...props} />;
  }
  const children = Array.from(el.childNodes).map((child, i) => convert(child, `${key}-${i}`));
  return <Tag key={key} {...props}>{children}</Tag>;
}

/**
 * Рендерит внешний HTML как React-элементы по allowlist.
 *
 * Пустой/битый HTML даёт `null` — вызывающая сторона сама решает, что
 * показать вместо описания.
 */
export function SafeHtml({ html, className }: { html: string; className?: string }) {
  const trimmed = html.trim();
  if (!trimmed) return null;
  const doc = new DOMParser().parseFromString(trimmed, "text/html");
  const body = doc.body;
  if (!body) return null;
  return (
    <div className={className}>
      {Array.from(body.childNodes).map((node, i) => convert(node, `h-${i}`))}
    </div>
  );
}
