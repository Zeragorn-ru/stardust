// Единая обёртка для пользовательского текста с эмодзи.
//
// Ники игроков, названия бейджей, заголовки новостей/гайдов, имена сезонов
// и сборок, summaries журнала — всё это контент, в который админ или игрок
// мог вставить эмодзи. Системный эмодзи-шрифт рисует их не так, как
// Mojangles в игре, поэтому везде, где такой текст показывается, его нужно
// пропускать через McEmoji (пиксельный SVG-глиф из public/emoji).
//
// Раньше McEmoji подключали точечно (PlayerCardModal, CustomizationView) и
// только к одиночному символу бейджа. McText разбирает ЦЕЛУЮ строку:
// известные эмодзи становятся глифами, остальной текст остаётся текстом.
// Символы без глифа McEmoji сам рисует текстовым фолбэком.

import type { ReactNode } from "react";
import McEmoji from "../emoji/McEmoji";
import { MC_EMOJI } from "../emoji/index";
import { STANDARD_TO_MC } from "../emoji/standardEmojiMap";
import { normalizeMinecraftText } from "../minecraftText";

/** Экранирует символ как последовательность \u{...} — безопасно для RegExp. */
function escapeForRegex(char: string): string {
  let out = "";
  for (const codePoint of char) {
    out += `\\u{${codePoint.codePointAt(0)?.toString(16) ?? "0"}}`;
  }
  return out;
}

/**
 * Множество символов, которые мы считаем эмодзи.
 *
 * Только НЕ-ASCII: индекс MC_EMOJI содержит цифры, «*» и «#» (Mojangles
 * рисует их как эмодзи-глифы), но превращать их в картинки внутри обычного
 * текста нельзя — ник «Player123» распался бы на три иконки.
 */
const EMOJI_CHARS: string[] = (() => {
  const chars = new Set<string>();
  for (const emoji of Object.values(MC_EMOJI)) {
    chars.add(normalizeMinecraftText(emoji.char));
  }
  // Стандартные эмодзи системной клавиатуры (😀 ✨) и их MC-эквиваленты:
  // McEmoji подставит ближайший глиф, а мы должны узнать сам символ.
  for (const standard of Object.keys(STANDARD_TO_MC)) {
    chars.add(normalizeMinecraftText(standard));
  }
  for (const mapped of Object.values(STANDARD_TO_MC)) {
    chars.add(normalizeMinecraftText(mapped));
  }
  return [...chars].filter((char) => (char.codePointAt(0) ?? 0) > 0x7f);
})();

const EMOJI_LOOKUP = new Set(EMOJI_CHARS);

// Самые длинные последовательности первыми, чтобы «☺️» не распалось на «☺».
const EMOJI_RE = new RegExp(
  `(${EMOJI_CHARS.slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeForRegex)
    .join("|")})`,
  "gu",
);

/** Есть ли в строке хоть один известный эмодзи (дешёвая проверка до рендера). */
export function hasMcEmoji(text: string): boolean {
  // EMOJI_RE — глобальный: test() двигает lastIndex, поэтому сбрасываем
  // его перед каждой проверкой, иначе повторный вызов соврёт.
  EMOJI_RE.lastIndex = 0;
  return EMOJI_RE.test(normalizeMinecraftText(text));
}

/**
 * Разбивает текст на куски: обычный текст и эмодзи.
 * Экспортируется, чтобы переиспользовать там, где нужна своя разметка.
 */
export function splitMcText(text: string): ReactNode[] {
  const normalized = normalizeMinecraftText(text);
  if (!EMOJI_LOOKUP.size || !hasMcEmoji(normalized)) return [normalized];

  const nodes: ReactNode[] = [];
  // lastIndex сбрасываем явно: EMOJI_RE — глобальный и используется повторно.
  EMOJI_RE.lastIndex = 0;
  const parts = normalized.split(EMOJI_RE);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    nodes.push(
      EMOJI_LOOKUP.has(part) ? (
        <McEmoji key={`e${i}`} char={part} />
      ) : (
        part
      ),
    );
  }
  return nodes;
}

interface McTextProps {
  /** Исходная строка (ник, название, summary журнала). */
  text: string | null | undefined;
  className?: string;
  /** Что показать вместо пустой строки (например, «—»). */
  fallback?: ReactNode;
}

/**
 * Пользовательский текст с майнкрафтовскими пиксель-глифами.
 *
 * Рендерит <span>, поэтому встраивается куда угодно: в <strong> таблицы,
 * в заголовок карточки, в строку журнала. Пустая строка → fallback (или null).
 */
export function McText({ text, className, fallback = null }: McTextProps) {
  if (text == null || text === "") return <>{fallback}</>;
  return <span className={className}>{splitMcText(text)}</span>;
}

export default McText;
