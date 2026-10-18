// Рендер эмодзи пиксельным глифом Mojangles «как в игре» (см. src/emoji.ts).
// Символа в индексе нет — текстовый фолбэк, как раньше.
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
    <img
      src={emoji.file}
      alt={alt ?? emoji.char}
      className={"mc-emoji" + (className ? ` ${className}` : "")}
      style={style}
      draggable={false}
    />
  );
}
