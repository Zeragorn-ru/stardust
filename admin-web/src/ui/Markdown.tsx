// Минимальный безопасный Markdown-рендер для живого предпросмотра
// редакторов новостей/гайдов (план 3.6). Поддерживает подмножество,
// которое принимает лаунчер: заголовки, списки, **жирный**, *курсив*,
// `код` и [ссылки](https://…).
//
// Рендер идёт в React-элементы: текст экранируется самим React, поэтому
// HTML-инъекция через тело поста невозможна (в отличие от innerHTML).

import type { ReactNode } from "react";

// Инлайн-разметка: картинка в ссылке, картинка, жирный, курсив, код, ссылка.
// Разделение через split с захватывающей группой кладёт совпадения между
// кусками plain-текста. Ссылочная картинка (`[![alt](img)](href)`) должна
// идти первой: иначе её съест обычный шаблон картинки.
const INLINE_RE =
  /(\[!\[[^\]\n]*\]\(https?:\/\/[^\s)]+\)\]\(https?:\/\/[^\s)]+\)|!\[[^\]\n]*\]\(https?:\/\/[^\s)]+\)|\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(INLINE_RE);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith("[![")) {
      const linked =
        /^\[!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
      if (linked) {
        out.push(
          <a key={key} href={linked[3]} target="_blank" rel="noopener noreferrer">
            <img
              src={linked[2]}
              alt={linked[1]}
              className="md-preview__img"
              loading="lazy"
            />
          </a>,
        );
      } else {
        out.push(part);
      }
    } else if (part.startsWith("![")) {
      const img = /^!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
      if (img) {
        out.push(
          <img
            key={key}
            src={img[2]}
            alt={img[1]}
            className="md-preview__img"
            loading="lazy"
          />,
        );
      } else {
        out.push(part);
      }
    } else if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
      out.push(<strong key={key}>{part.slice(2, -2)}</strong>);
    } else if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      out.push(<code key={key}>{part.slice(1, -1)}</code>);
    } else if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
      out.push(<em key={key}>{part.slice(1, -1)}</em>);
    } else if (part.startsWith("[")) {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
      if (link) {
        out.push(
          <a key={key} href={link[2]} target="_blank" rel="noopener noreferrer">
            {link[1]}
          </a>,
        );
      } else {
        out.push(part);
      }
    } else {
      out.push(part);
    }
  }
  return out;
}

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const UL_ITEM_RE = /^[-*]\s+/;
const OL_ITEM_RE = /^\d+\.\s+/;
// Строка начинается с новой блочной структуры — абзац на ней заканчивается.
const BLOCK_START_RE = /^(#{1,3}\s|[-*]\s|\d+\.\s)/;

/**
 * Приводит сырой HTML внутри Markdown к тексту: описания на Modrinth массово
 * содержат `<center>`, `<img>`, `<br>`, `<details>` — без нормализации они
 * попадали в вывод literal-тегами. Картинки переводим в `![alt](src)`,
 * `<br>` — в перевод строки, остальные теги превращаем в их текст.
 *
 * Разметка идёт через DOMParser: скрипты и обработчики не исполняются,
 * а результат рендерится React-элементами, поэтому XSS тут невозможен.
 */
function normalizeInlineHtml(text: string): string {
  if (!/<[a-z!/][^>]*>/i.test(text)) return text;
  const doc = new DOMParser().parseFromString(text, "text/html");
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") return "\n";
    if (tag === "img") {
      const src = el.getAttribute("src") ?? "";
      const alt = el.getAttribute("alt") ?? "";
      // Только http(s): прочие схемы в src недопустимы.
      return /^https?:\/\//.test(src) ? `![${alt}](${src})` : "";
    }
    const inner = Array.from(el.childNodes).map(walk).join("");
    // Блочные теги разделяем пустой строкой, чтобы абзацы не склеивались.
    return BLOCK_TAGS.has(tag) ? `\n\n${inner}\n\n` : inner;
  };
  return Array.from(doc.body.childNodes)
    .map(walk)
    .join("")
    .replace(/\n{3,}/g, "\n\n");
}

/** Теги, которые в описаниях ведут себя как блочные. */
const BLOCK_TAGS = new Set([
  "p", "div", "center", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "table", "tr", "td", "th", "section", "article", "details",
  "summary", "pre",
]);

const HEADING_TAGS = ["h1", "h2", "h3"] as const;

/** Разметить текст в блоки: заголовки, списки, абзацы. */
function renderBlocks(text: string): ReactNode[] {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const Tag = HEADING_TAGS[heading[1].length - 1];
      blocks.push(<Tag key={key++}>{renderInline(heading[2], `h${key}`)}</Tag>);
      i++;
      continue;
    }

    if (UL_ITEM_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL_ITEM_RE.test(lines[i])) {
        items.push(lines[i].replace(UL_ITEM_RE, ""));
        i++;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((item, j) => (
            <li key={j}>{renderInline(item, `ul${key}-${j}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (OL_ITEM_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OL_ITEM_RE.test(lines[i])) {
        items.push(lines[i].replace(OL_ITEM_RE, ""));
        i++;
      }
      blocks.push(
        <ol key={key++}>
          {items.map((item, j) => (
            <li key={j}>{renderInline(item, `ol${key}-${j}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Абзац: строки до пустой или до начала следующей блочной структуры.
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !BLOCK_START_RE.test(lines[i])
    ) {
      paragraph.push(lines[i]);
      i++;
    }
    blocks.push(<p key={key++}>{renderInline(paragraph.join(" "), `p${key}`)}</p>);
  }

  return blocks;
}

/**
 * Живой предпросмотр Markdown. Пустой текст показывает заглушку —
 * превью не должно «исчезать» и сдвигать раскладку при старте.
 */
export function Markdown({ text }: { text: string }) {
  if (text.trim() === "") {
    return (
      <p className="muted md-preview__empty">
        Начните печатать — предпросмотр появится здесь.
      </p>
    );
  }
  return <div className="md-preview">{renderBlocks(normalizeInlineHtml(text))}</div>;
}
