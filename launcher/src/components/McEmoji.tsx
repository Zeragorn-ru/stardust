// Рендер эмодзи пиксельным глифом Mojangles «как в игре» (см. src/emoji.ts).
// Символа в индексе нет — текстовый фолбэк, как раньше.
import type { CSSProperties } from "react";
import { findMcEmoji } from "../emoji";
import { normalizeMinecraftText } from "../minecraftText";

interface Props {
  /** Символ эмодзи (как хранится в бейдже). */
  char: string;
  className?: string;
  style?: CSSProperties;
  alt?: string;
}

export default function McEmoji({ char, className, style, alt }: Props) {
  const emoji = findMcEmoji(normalizeMinecraftText(char));
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
