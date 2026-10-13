// Минимальный безопасный Markdown-рендер для живого предпросмотра
// редакторов новостей/гайдов (план 3.6). Поддерживает подмножество,
// которое принимает лаунчер: заголовки, списки, **жирный**, *курсив*,
// `код` и [ссылки](https://…).
//
// Рендер идёт в React-элементы: текст экранируется самим React, поэтому
// HTML-инъекция через тело поста невозможна (в отличие от innerHTML).

import type { ReactNode } from "react";

// Инлайн-разметка: жирный, курсив, код, ссылка. Разделение через split
// с захватывающей группой кладёт совпадения между кусками plain-текста.
const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = text.split(INLINE_RE);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const key = `${keyPrefix}-${i}`;
    if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
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
  return <div className="md-preview">{renderBlocks(text)}</div>;
}
