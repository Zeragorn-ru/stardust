// Пиксельный глиф Mojangles: инлайн-SVG наследует цвет текста или бейджа.
import type { CSSProperties } from "react";
import { findMcEmoji } from "./index";
import { EMOJI_GLYPHS } from "./glyphs";
import { STANDARD_TO_MC } from "./standardEmojiMap";
import { normalizeMinecraftText } from "../minecraftText";

interface Props {
  char: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
  alt?: string;
}

export default function McEmoji({ char, size, className, style, alt }: Props) {
  const normalized = normalizeMinecraftText(char);
  const emoji = findMcEmoji(normalized) ?? findMcEmoji(STANDARD_TO_MC[normalized] ?? "");
  const slug = emoji?.file.match(/emoji-([^/]+)\.svg$/)?.[1];
  const glyph = slug ? EMOJI_GLYPHS[slug] : undefined;
  const sizeStyle: CSSProperties = size ? { width: size, height: size } : {};
  if (!glyph || !emoji) {
    return (
      <span
        className={"mc-emoji-fallback" + (className ? ` ${className}` : "")}
        style={{ ...sizeStyle, ...style }}
        title={alt}
      >
        {emoji?.char ?? normalized}
      </span>
    );
  }
  return (
    <svg
      role="img"
      aria-label={alt ?? emoji.char}
      className={"mc-emoji" + (className ? ` ${className}` : "")}
      style={{ ...sizeStyle, ...style }}
      viewBox={glyph.vb}
      fill="currentColor"
    >
      {alt && <title>{alt}</title>}
      <path d={glyph.d} fillRule="evenodd" clipRule="evenodd" />
    </svg>
  );
}
