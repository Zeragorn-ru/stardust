// Рендер эмодзи пиксельным глифом Mojangles «как в игре» (см. src/emoji.ts).
// Символа в индексе нет — текстовый фолбэк, как раньше.
//
// Глифы — SVG с fill="currentColor". Через <img> currentColor не наследует
// цвет страницы (внутри <img> документ изолирован, цвет схлопывается в чёрный),
// поэтому на тёмном UI иконки были невидимы, а цвет бейджа терялся. Рисуем
// span'ом с CSS-маской: background-color: currentColor берёт цвет текста или
// бейджа, маска вырезает форму глифа. См. .mc-emoji в styles.css.
import type { CSSProperties } from "react";
import { findMcEmoji } from "../emoji";
import { STANDARD_TO_MC } from "../standardEmojiMap";
import { normalizeMinecraftText } from "../minecraftText";

interface Props {
  /** Символ эмодзи (как хранится в бейдже). */
  char: string;
  className?: string;
  style?: CSSProperties;
  alt?: string;
}

export default function McEmoji({ char, className, style, alt }: Props) {
  const normalized = normalizeMinecraftText(char);
  // Сначала точный глиф; стандартные эмодзи из системной клавиатуры
  // (😀 👍 ✨) в Minecraft отсутствуют — подставляем ближайший MC-эквивалент.
  const emoji = findMcEmoji(normalized) ?? findMcEmoji(STANDARD_TO_MC[normalized] ?? "");
  if (!emoji) {
    return (
      <span
        className={"mc-emoji-fallback" + (className ? ` ${className}` : "")}
        style={style}
        title={alt}
      >
        {normalizeMinecraftText(char)}
      </span>
    );
  }
  return (
    <span
      role="img"
      aria-label={alt ?? emoji.char}
      title={alt}
      className={"mc-emoji" + (className ? ` ${className}` : "")}
      style={{ ...style, ["--mc-emoji-src" as string]: `url(${emoji.file})` }}
    />
  );
}
