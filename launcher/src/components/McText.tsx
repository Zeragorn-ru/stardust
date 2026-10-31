// Рендерит произвольный текст, заменяя каждый эмодзи пиксельным глифом
// Mojangles «как в игре» (см. McEmoji). Обычный текст остаётся текстом —
// компоненты-обёртка нужна там, где эмодзи приходят из динамических строк
// (сводки крашей, новости, заголовки), а не из фиксированного JSX.
//
// Разбиваем строку на графемные кластеры (Intl.Segmenter): эмодзи часто
// состоят из нескольких кодовых точек (вариативный селектор U+FE0F,
// модификаторы тона кожи, ZWJ-последовательности), и находить их нужно
// целиком, а не по одному символу.
import { Fragment, type ReactNode } from "react";
import McEmoji from "./McEmoji";
import { findMcEmoji } from "../emoji";
import { STANDARD_TO_MC } from "../standardEmojiMap";
import { normalizeMinecraftText } from "../minecraftText";

interface Props {
  text: string;
  className?: string;
}

// Минимальное описание Intl.Segmenter: его нет в текущей TS lib, а нужен он
// здесь только чтобы корректно резать эмодзи на графемные кластеры.
interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}

/** Разбивает строку на графемные кластеры; без Intl.Segmenter — на кодовые точки. */
function graphemes(value: string): string[] {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locale: string, options: { granularity: string }) => GraphemeSegmenter;
  }).Segmenter;
  if (Segmenter) {
    try {
      const segments = new Segmenter("ru", { granularity: "grapheme" }).segment(value);
      return Array.from(segments, (part) => part.segment);
    } catch {
      // Segmenter есть в типах, но не работает в этой среде — падаем ниже.
    }
  }
  return Array.from(value);
}

/** Есть ли для кластера Minecraft-глиф (прямой или через STANDARD_TO_MC). */
function hasMcGlyph(cluster: string): boolean {
  const normalized = normalizeMinecraftText(cluster);
  if (!normalized) return false;
  // Индекс MC_EMOJI содержит ASCII-глифы (цифры, «*», «#» — Mojangles рисует
  // их как эмодзи), но подменять их внутри обычного текста нельзя: «3 записей»
  // или «*жирный*» распались бы на картинки. Обрабатываем только не-ASCII.
  const first = normalized.codePointAt(0) ?? 0;
  if (first <= 0x7f) return false;
  return Boolean(findMcEmoji(normalized) ?? findMcEmoji(STANDARD_TO_MC[normalized] ?? ""));
}

export default function McText({ text, className }: Props) {
  const nodes: ReactNode[] = [];
  // Склеиваем подряд идущие обычные (не-эмодзи) кластеры в один текстовый узел,
  // чтобы не плодить десятки span'ов на предложение.
  let buffer = "";
  graphemes(text).forEach((cluster, index) => {
    if (hasMcGlyph(cluster)) {
      if (buffer) {
        nodes.push(<Fragment key={`t${index}`}>{buffer}</Fragment>);
        buffer = "";
      }
      nodes.push(<McEmoji key={`e${index}`} char={cluster} className={className} />);
    } else {
      buffer += cluster;
    }
  });
  if (buffer) nodes.push(<Fragment key="tail">{buffer}</Fragment>);
  return <>{nodes}</>;
}
