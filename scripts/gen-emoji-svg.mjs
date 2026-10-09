#!/usr/bin/env node
// Генератор SVG-пака Minecraft-совместимых эмодзи для Stardust.
//
// Что делает:
//   1. Читает исходный список эмодзи (gist «Minecraft allowed emojis»).
//   2. Читает шрифт Mojangles (Minecraft Default / «Minecraft Seven», сборка 26.2)
//      и извлекает из CFF-таблицы точные пиксельные контуры каждого глифа.
//      Внешних зависимостей нет — только встроенные модули Node: разбор OTF/CFF
//      (cmap, hmtx, CharStrings, Type 2 charstring interpreter) написан ниже.
//   3. Пишет в admin-web/public/emoji/:
//        - emoji-<slug>.svg — один файл на эмодзи, <path> с fill-rule="evenodd",
//          viewBox в пиксельной сетке 9x8 (1 юнит = 1 «пиксель» шрифта 8x8);
//        - manifest.json — символ, имя, слаг, codepoint, тир (native/extra/text);
//        - emoji.css — готовые классы .mc-emoji-<slug>;
//        - index.ts — типизированный реэкспорт для React/Vite (кладём в src/emoji/).
//   4. Эмодзи, которых нет в шрифте, получает <text>-фолбэк (по честному задокументирован
//      в README: рендер зависит от системных шрифтов).
//
// Запуск:
//   node scripts/gen-emoji-svg.mjs [--font path/to/26.2-Minecraft-Regular.otf] \
//                                  [--source /tmp/mc-emojis.txt] \
//                                  [--out admin-web/public/emoji] [--src-out admin-web/src/emoji]
//
// Шрифт по умолчанию ищется в ./third_party/fonts/ или /tmp/mc-emoji-src/.
// Источник шрифта: https://archive.org/details/minecraft-seven (26.2-Minecraft-Regular.otf).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { argv, exit } from "node:process";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const FONT_CANDIDATES = [
  arg("font"),
  join(ROOT, "third_party/fonts/26.2-Minecraft-Regular.otf"),
  "/tmp/mc-emoji-src/26.2-Minecraft-Regular.otf",
].filter(Boolean);

const SOURCE = arg("source", "/tmp/mc-emojis.txt");
const OUT_DIR = arg("out", join(ROOT, "admin-web/public/emoji"));
const SRC_OUT = arg("src-out", join(ROOT, "admin-web/src/emoji"));

const fontPath = FONT_CANDIDATES.find((p) => existsSync(p));
if (!fontPath) {
  console.error(
    `Шрифт Mojangles не найден. Положите 26.2-Minecraft-Regular.otf в third_party/fonts/ ` +
      `или /tmp/mc-emoji-src/, либо укажите --font.\n` +
      `Источник: https://archive.org/download/minecraft-seven/26.2-Minecraft-Regular.otf`,
  );
  exit(1);
}

// ---------------------------------------------------------------------------
// 1. Парсинг gist-списка
// ---------------------------------------------------------------------------

function parseSource(text) {
  const entries = [];
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("\\#")) {
      entries.push({ char: "#", name: line.slice(2).trim() });
      continue;
    }
    const m = line.match(/^(\S+)\s+(.+)$/);
    if (!m) continue;
    const ch = m[1];
    if (ch === "\u200d") continue; // «пустая» строка из gist
    const isUnicode = [...ch].some((c) => c.codePointAt(0) > 127);
    const isAsciiSymbol = ch === "*" || /^[0-9]$/.test(ch);
    if (isUnicode || isAsciiSymbol) {
      entries.push({ char: ch, name: m[2].trim() });
    }
  }
  return entries;
}

function slugify(name) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[«»"'“”‘’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "glyph";
}

// 44 «нативных» эмодзи Mojangles (Minecraft.wiki, с 1.20.2 рисуются самим шрифтом).
const NATIVE_CODEPOINTS = new Set([
  0x2600, 0x2601, 0x2602, 0x2603, 0x2604, 0x2611, 0x2614, 0x2620, 0x262e, 0x262f,
  0x2639, 0x263a, 0x2640, 0x2642, 0x2660, 0x2663, 0x2665, 0x2666, 0x2693, 0x2694,
  0x2697, 0x26a0, 0x26a1, 0x26c4, 0x26c8, 0x26cf, 0x2709, 0x2714, 0x2763, 0x2764,
  0x2744, 0x1f525, 0x1f30a, 0x1f5e1, 0x1f3f9, 0x1fa93, 0x1f531, 0x1f3a3, 0x1f9ea,
  0x2702, 0x1f356, 0x1faa3, 0x1f514, 0x23f3,
]);

// 21 «нативных» эмодзи из набора 1.20.2+, которых нет в старом gist-списке.
// Имена — в стиле gist (Unicode CLDR), добавляются к распарсенному списку.
const EXTRA_NATIVE = [
  ["☔", "Umbrella with Rain Drops"],
  ["⚓", "Anchor"],
  ["⚔", "Crossed Swords"],
  ["⚗", "Alembic"],
  ["⚠", "Warning"],
  ["⚡", "High Voltage"],
  ["⛄", "Snowman Without Snow"],
  ["⛈", "Cloud with Lightning and Rain"],
  ["⛏", "Pick"],
  ["\u{1f525}", "Fire"],
  ["\u{1f30a}", "Water Wave"],
  ["\u{1f5e1}", "Dagger"],
  ["\u{1f3f9}", "Bow and Arrow"],
  ["\u{1fa93}", "Axe"],
  ["\u{1f531}", "Trident"],
  ["\u{1f3a3}", "Fishing Pole"],
  ["\u{1f9ea}", "Test Tube"],
  ["\u{1f356}", "Meat on Bone"],
  ["\u{1faa3}", "Bucket"],
  ["\u{1f514}", "Bell"],
  ["⏳", "Hourglass Done"],
];

// ---------------------------------------------------------------------------
// 2. Разбор OTF/CFF (без зависимостей)
// ---------------------------------------------------------------------------

const fontData = readFileSync(fontPath);

function u16(off) {
  return fontData.readUInt16BE(off);
}
function u32(off) {
  return fontData.readUInt32BE(off);
}

const numTables = u16(4);
const tables = {};
for (let i = 0; i < numTables; i++) {
  const off = 12 + 16 * i;
  const tag = fontData.toString("latin1", off, off + 4).trim();
  tables[tag] = [u32(off + 8), u32(off + 12)];
}

// --- INDEX (CFF) ---
function parseIndex(pos) {
  const count = u16(pos);
  if (count === 0) return { end: pos + 2, items: [] };
  const offSize = fontData[pos + 2];
  const offsets = [];
  let p = pos + 3;
  for (let i = 0; i <= count; i++) {
    let off = 0;
    for (let b = 0; b < offSize; b++) off = off * 256 + fontData[p + i * offSize + b];
    offsets.push(off);
  }
  const dataStart = p + (count + 1) * offSize;
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push(fontData.subarray(dataStart + offsets[i] - 1, dataStart + offsets[i + 1] - 1));
  }
  return { end: dataStart + offsets[count] - 1, items };
}

const cffOff = tables["CFF"][0];
const topDict = (() => {
  // hdrSize = 4: Name INDEX -> Top DICT INDEX
  let p = cffOff + 4;
  p = parseIndex(p).end; // Name INDEX
  return parseIndex(p).items[0];
})();

// Top DICT: ищем CharStrings (op 17) — перебираем операнды/операторы.
function parseTopDict(dict) {
  const entries = [];
  let i = 0;
  let operands = [];
  while (i < dict.length) {
    const b0 = dict[i];
    if (b0 === 28) {
      operands.push(dict.readInt16BE(i + 1));
      i += 3;
    } else if (b0 === 29) {
      operands.push(dict.readInt32BE(i + 1));
      i += 5;
    } else if (b0 === 30) {
      i += 1;
      while (i < dict.length) {
        const b = dict[i];
        i += 1;
        if ((b & 0x0f) === 0x0f || (b >> 4) === 0x0f) break;
      }
    } else if (b0 <= 21) {
      let op = b0;
      i += 1;
      if (b0 === 12) {
        op = 1200 + dict[i];
        i += 1;
      }
      entries.push([op, operands]);
      operands = [];
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
      i += 1;
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + dict[i + 1] + 108);
      i += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - dict[i + 1] - 108);
      i += 2;
    } else {
      i += 1;
    }
  }
  return entries;
}

const topEntries = parseTopDict(topDict);
let charstringsOffset = null;
for (const [op, vals] of topEntries) {
  if (op === 17) charstringsOffset = cffOff + vals[0];
}
if (charstringsOffset === null) throw new Error("CharStrings не найден в Top DICT");

const charstrings = parseIndex(charstringsOffset).items;

// --- cmap (format 12) ---
const cmapOff = tables["cmap"][0];
const cmapSubtables = u16(cmapOff + 2);
let bestCmap = null;
for (let i = 0; i < cmapSubtables; i++) {
  const roff = cmapOff + 4 + 8 * i;
  const platformID = u16(roff);
  const encodingID = u16(roff + 2);
  const offset = u32(roff + 4);
  if (platformID === 3 && encodingID === 10) {
    bestCmap = cmapOff + offset;
    break;
  }
  if (platformID === 0) bestCmap = cmapOff + offset;
}
const cmapFormat = u16(bestCmap);
const unicodeToGid = new Map();
if (cmapFormat === 12) {
  const nGroups = u32(bestCmap + 12);
  for (let i = 0; i < nGroups; i++) {
    const goff = bestCmap + 16 + 12 * i;
    const start = u32(goff);
    const end = u32(goff + 4);
    const gid = u32(goff + 8);
    for (let cp = start; cp <= end; cp++) unicodeToGid.set(cp, gid + (cp - start));
  }
} else if (cmapFormat === 4) {
  // не встречается в этом шрифте, но пусть будет для устойчивости
  const segCount = u16(bestCmap + 6) / 2;
  const endCodeOff = bestCmap + 14;
  const startCodeOff = endCodeOff + segCount * 2 + 2;
  const idDeltaOff = startCodeOff + segCount * 2;
  for (let i = 0; i < segCount; i++) {
    const end = u16(endCodeOff + 2 * i);
    const start = u16(startCodeOff + 2 * i);
    const delta = fontData.readInt16BE(idDeltaOff + 2 * i);
    if (start === 0xffff) continue;
    for (let cp = start; cp <= Math.min(end, 0xfffd); cp++) {
      unicodeToGid.set(cp, (cp + delta) & 0xffff);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Type 2 charstring interpreter (только те операторы, что реально есть в шрифте)
// ---------------------------------------------------------------------------

function interpretCharstring(bytes) {
  let i = 0;
  let stack = [];
  let x = 0;
  let y = 0;
  let nStems = 0;
  const contours = [];
  let current = null;

  const pushContour = () => {
    if (current && current.length > 1) contours.push(current);
    current = null;
  };

  while (i < bytes.length) {
    const b0 = bytes[i];
    // escape / hinting / прочие служебные — в этих глифах не встречаются,
    // но пропускаем корректно, чтобы не рассинхронизировать поток.
    if (b0 === 12) {
      i += 2;
      stack = [];
      continue;
    }
    if (b0 === 1 || b0 === 3 || b0 === 18 || b0 === 23) {
      nStems += Math.floor(stack.length / 2);
      stack = [];
      i += 1;
      continue;
    }
    if (b0 === 19 || b0 === 20) {
      i += 1 + Math.ceil(nStems / 8);
      stack = [];
      continue;
    }
    if (b0 === 10 || b0 === 29) {
      throw new Error("callsubr/callgsubr не поддержан (в этом шрифте не встречается)");
    }
    if (b0 === 11) {
      i += 1;
      continue;
    }
    if (b0 === 14) {
      pushContour();
      break;
    }

    // path-операторы
    if (b0 === 21) {
      // rmoveto: [width?] dx dy
      if (stack.length > 2) stack = stack.slice(-2);
      x += stack[0];
      y += stack[1];
      pushContour();
      current = [[x, y]];
      stack = [];
      i += 1;
      continue;
    }
    if (b0 === 22) {
      // hmoveto: [width?] dx
      x += stack[stack.length - 1];
      pushContour();
      current = [[x, y]];
      stack = [];
      i += 1;
      continue;
    }
    if (b0 === 4) {
      // vmoveto: [width?] dy
      y += stack[stack.length - 1];
      pushContour();
      current = [[x, y]];
      stack = [];
      i += 1;
      continue;
    }
    if (b0 === 5) {
      // rlineto: пары dx dy
      for (let k = 0; k + 1 < stack.length; k += 2) {
        x += stack[k];
        y += stack[k + 1];
        current.push([x, y]);
      }
      stack = [];
      i += 1;
      continue;
    }
    if (b0 === 6 || b0 === 7) {
      // hlineto / vlineto: чередование осей, начиная с «своей»
      let horiz = b0 === 6;
      for (const a of stack) {
        if (horiz) x += a;
        else y += a;
        current.push([x, y]);
        horiz = !horiz;
      }
      stack = [];
      i += 1;
      continue;
    }

    // числа
    if (b0 === 28) {
      stack.push(bytes.readInt16BE(i + 1));
      i += 3;
    } else if (b0 === 255) {
      stack.push(bytes.readInt32BE(i + 1) / 65536);
      i += 5;
    } else if (b0 >= 32 && b0 <= 246) {
      stack.push(b0 - 139);
      i += 1;
    } else if (b0 >= 247 && b0 <= 250) {
      stack.push((b0 - 247) * 256 + bytes[i + 1] + 108);
      i += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      stack.push(-(b0 - 251) * 256 - bytes[i + 1] - 108);
      i += 2;
    } else {
      throw new Error(`неизвестный байт charstring: ${b0}`);
    }
  }
  pushContour();
  return contours;
}

// ---------------------------------------------------------------------------
// 4. Геометрия: font units -> пиксельная сетка
// ---------------------------------------------------------------------------

// EM = 1024 юнита = 8 пикселей по 128. Baseline: y=-128..896 (ascender 896).
// SVG: y растёт вниз. Пиксель (col,row): x = col..col+1, y = row..row+1.
// fontY=896 -> svgY 0 (верх), fontY=-128 -> svgY 8 (низ).
const CELL = 128;
const EM_TOP = 896;
const toPixel = (pt) => [pt[0] / CELL, (EM_TOP - pt[1]) / CELL];

function contourToPath(contour, xShift = 0) {
  const pts = contour.map((p) => {
    const [x, y] = toPixel(p);
    return [x + xShift, y];
  });
  // округляем к 1/8 пикселя, чтобы убрать 1-юнитовые «срезанные» диагонали (127/129 и т.п.)
  const snap = (v) => Math.round(v * 8) / 8;
  let d = `M${snap(pts[0][0])} ${snap(pts[0][1])}`;
  for (let k = 1; k < pts.length; k++) {
    d += `L${snap(pts[k][0])} ${snap(pts[k][1])}`;
  }
  return d + "Z";
}

function glyphToSvgBody(gid) {
  const bytes = charstrings[gid];
  const contours = interpretCharstring(bytes);
  if (contours.length === 0) return null;

  // Центрируем глиф по горизонтали в сетке 9 пикселей: узкие глифы (пешка, молния)
  // иначе прилипают к левому краю и на 64px выглядят крошечными и смещёнными.
  const allPts = contours.flat();
  const xMin = Math.min(...allPts.map((p) => p[0]));
  const xMax = Math.max(...allPts.map((p) => p[0]));
  const glyphWidth = (xMax - xMin) / CELL;
  const shift = (9 - glyphWidth) / 2 - xMin / CELL;

  const ds = contours.map((c) => contourToPath(c, shift));
  return `<path fill-rule="evenodd" clip-rule="evenodd" d="${ds.join(" ")}"/>`;
}

// ---------------------------------------------------------------------------
// 5. Генерация SVG
// ---------------------------------------------------------------------------

const sourceText = readFileSync(SOURCE, "utf8");
const entries = parseSource(sourceText);
// добавляем 1.20.2+ эмодзи, которых в старом gist нет (в игре с 1.21.1 они есть)
for (const [ch, name] of EXTRA_NATIVE) {
  if (!entries.some((e) => e.char === ch)) entries.push({ char: ch, name });
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SRC_OUT, { recursive: true });

const manifest = [];
const cssRules = [];
const indexEntries = [];
let countNative = 0;
let countExtra = 0;
let countText = 0;
const seenSlugs = new Map();

for (const { char, name } of entries) {
  const cps = [...char].map((c) => c.codePointAt(0));
  const cp = cps[0];
  const isNative = NATIVE_CODEPOINTS.has(cp);
  const gid = unicodeToGid.get(cp);

  let slug = slugify(name);
  if (seenSlugs.has(slug)) {
    const n = seenSlugs.get(slug) + 1;
    seenSlugs.set(slug, n);
    slug = `${slug}-${n}`;
  } else {
    seenSlugs.set(slug, 1);
  }

  const filename = `emoji-${slug}.svg`;
  let svg = null;
  let tier;

  if (gid !== undefined) {
    const body = glyphToSvgBody(gid);
    if (body) {
      tier = isNative ? "native" : "extra";
      svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 8" width="64" height="64" ` +
        `fill="currentColor" role="img" aria-label="${escapeXml(name)}">` +
        `<title>${escapeXml(name)}</title>` +
        body +
        `</svg>\n`;
    }
  }

  if (!svg) {
    // глифа нет в шрифте — текстовый фолбэк
    tier = "text";
    svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" ` +
      `role="img" aria-label="${escapeXml(name)}">` +
      `<title>${escapeXml(name)}</title>` +
      `<text x="32" y="38" text-anchor="middle" dominant-baseline="central" ` +
      `font-family="'Minecraft','Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif" ` +
      `font-size="48" fill="currentColor">${escapeXml(char)}</text>` +
      `</svg>\n`;
  }

  writeFileSync(join(OUT_DIR, filename), svg);
  if (tier === "native") countNative++;
  else if (tier === "extra") countExtra++;
  else countText++;

  manifest.push({
    char,
    codepoints: cps.map((c) => "U+" + c.toString(16).toUpperCase().padStart(4, "0")),
    name,
    slug,
    file: filename,
    tier,
  });
  cssRules.push(
    `.mc-emoji-${slug}{--mc-emoji:"${char.replace(/"/g, '\\"')}";background-image:url("emoji/${filename}")}`,
  );
  indexEntries.push(`  "${slug}": { char: ${jsString(char)}, file: "emoji/${filename}", tier: "${tier}" },`);
}

// --- manifest.json ---
writeFileSync(
  join(OUT_DIR, "manifest.json"),
  JSON.stringify(
    {
      generator: "scripts/gen-emoji-svg.mjs",
      source: "gist «Minecraft allowed emojis» + Minecraft.wiki (Mojangles, 44 native emoji)",
      font: "Mojangles / Minecraft Default Regular 26.2 (archive.org/details/minecraft-seven)",
      viewBox: "0 0 9 8",
      pixelGrid: "1 юнит = 1 пиксель глифа (8x8, EM 1024, cell 128)",
      fillRule: "evenodd",
      license: "Глифы Mojang; Minecraft Usage Guidelines; см. README.md",
      count: manifest.length,
      emoji: manifest,
    },
    null,
    2,
  ) + "\n",
);

// --- emoji.css ---
writeFileSync(
  join(OUT_DIR, "emoji.css"),
  `/* Сгенерировано scripts/gen-emoji-svg.mjs — не редактировать руками.\n` +
    ` Классы для вставки эмодзи как background-image. Тир: native/extra — пиксельные контуры\n` +
    ` Mojangles; text — текстовый фолбэк. */\n` +
    cssRules.map((r) => r.replace('background-image:url("emoji/', 'background-image:url("./')).join("\n") +
    "\n",
);

// --- index.ts (типизированный индекс) ---
writeFileSync(
  join(SRC_OUT, "index.ts"),
  `// Сгенерировано scripts/gen-emoji-svg.mjs — не редактировать руками.
// Индекс Minecraft-совместимых эмодзи. SVG лежат в public/emoji и раздаются
// Vite как статика: путь в \`file\` — URL от корня приложения.

export type EmojiTier = "native" | "extra" | "text";

export interface McEmoji {
/** Символ для вставки в чат Minecraft. */
char: string;
/** Путь к SVG (URL от корня, раздаётся из public/emoji). */
file: string;
/** native — 44 эмодзи, рисуемых самим Mojangles; extra — остальной gist; text — фолбэк. */
tier: EmojiTier;
}

export const MC_EMOJI: Record<string, McEmoji> = {
${indexEntries.join("\n")}
};

export const MC_EMOJI_COUNT = ${manifest.length};

/** Все эмодзи, которые Minecraft рисует сам (Mojangles, с 1.20.2). */
export const MC_EMOJI_NATIVE: McEmoji[] = Object.values(MC_EMOJI).filter((e) => e.tier === "native");

/** Найти запись по символу. */
export function findMcEmoji(char: string): McEmoji | undefined {
return Object.values(MC_EMOJI).find((e) => e.char === char);
}
`,
);

console.log(`Готово: ${manifest.length} SVG (${countNative} native, ${countExtra} extra, ${countText} text)`);
  console.log(`  каталог:  ${OUT_DIR}`);
  console.log(`  индекс TS: ${join(SRC_OUT, "index.ts")}`);
  console.log(`  шрифт:    ${fontPath}`);

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function jsString(s) {
  return JSON.stringify(s);
}
