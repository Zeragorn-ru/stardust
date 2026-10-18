// Рендер эмодзи пиксельным глифом Mojangles «как в игре».
//
// Системные эмодзи-шрифты браузера рисуют ☠/☀/🔥 совсем не так, как Minecraft:
// игрок не узнает то, что реально попадёт в чат. SVG-пак (public/emoji,
// scripts/gen-emoji-svg.mjs) даёт точные контуры глифов — показываем их
// inline. Символа в индексе нет — остаётся текстовый фолбэк (normalize
// + font-variant-emoji), как раньше.
import type { CSSProperties } from "react";
import { findMcEmoji } from "./index";
import { normalizeMinecraftText } from "../minecraftText";

interface Props {
  /** Символ эмодзи (как хранится в бейдже). */
  char: string;
  /** Размер квадратной иконки (по умолчанию 1em — как глиф текста). */
  size?: number;
  className?: string;
  style?: CSSProperties;
  alt?: string;
}

export default function McEmoji({ char, size, className, style, alt }: Props) {
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
      width={size}
      height={size}
      className={"mc-emoji" + (className ? ` ${className}` : "")}
      style={style}
      draggable={false}
    />
  );
}
