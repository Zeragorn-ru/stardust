// Рендер эмодзи пиксельным глифом Mojangles «как в игре».
//
// Системные эмодзи-шрифты браузера рисуют ☠/☀/🔥 совсем не так, как Minecraft:
// игрок не узнает то, что реально попадёт в чат. SVG-пак (public/emoji,
// scripts/gen-emoji-svg.mjs) даёт точные контуры глифов — показываем их
// inline. Символа в индексе нет — остаётся текстовый фолбэк (normalize
// + font-variant-emoji), как раньше.
//
// Глифы — SVG с fill="currentColor". Через <img> currentColor не наследует
// цвет страницы (документ внутри <img> изолирован, цвет схлопывается в
// чёрный) — иконки пропадали на тёмном фоне, цвет бейджа терялся. Рисуем
// span'ом с CSS-маской: background-color: currentColor берёт цвет текста
// или бейджа, маска вырезает форму. См. .mc-emoji в styles.css.
import type { CSSProperties } from "react";
import { findMcEmoji } from "./index";
import { STANDARD_TO_MC } from "./standardEmojiMap";
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
  const sizeStyle: CSSProperties = size ? { width: size, height: size } : {};
  return (
    <span
      role="img"
      aria-label={alt ?? emoji.char}
      title={alt}
      className={"mc-emoji" + (className ? ` ${className}` : "")}
      style={{ ...sizeStyle, ...style, ["--mc-emoji-src" as string]: `url(${emoji.file})` }}
    />
  );
}
