#!/usr/bin/env node
// Генератор инлайн-глифов Minecraft-эмодзи для Stardust.
//
// Инлайн-SVG наследует цвет и не зависит от пути к внешнему файлу маски.
//
// Что делает: читает уже собранные SVG (launcher/public/emoji, admin-web/public/emoji),
// вытаскивает viewBox и data каждого <path> и пишет типизированные карты:
//   - launcher/src/emojiGlyphs.ts
//   - admin-web/src/emoji/glyphs.ts
// Ключ карты — слаг (имя файла без «emoji-» и «.svg»), совпадает с ключом MC_EMOJI.
// Глифы-фолбэки (<text>, тир «text») пропускаются: McEmoji рисует их символ текстом.
//
// Запуск: node scripts/gen-emoji-glyphs.mjs
// Зависимостей нет — только встроенные модули Node. SVG генерирует gen-emoji-svg.mjs.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

const TARGETS = [
  { svgDir: join(ROOT, "launcher/public/emoji"), out: join(ROOT, "launcher/src/emojiGlyphs.ts") },
  { svgDir: join(ROOT, "admin-web/public/emoji"), out: join(ROOT, "admin-web/src/emoji/glyphs.ts") },
];

/** Достаёт viewBox и d единственного <path> из SVG; null для <text>-глифов. */
function parseGlyph(svg) {
  const vb = svg.match(/viewBox="([^"]+)"/);
  const d = svg.match(/<path[^>]*\sd="([^"]+)"/);
  if (!vb || !d) return null;
  return { vb: vb[1], d: d[1] };
}

let report = [];
for (const { svgDir, out } of TARGETS) {
  if (!existsSync(svgDir)) {
    console.error(`Нет каталога ${svgDir}`);
    process.exit(1);
  }
  const entries = [];
  let skipped = [];
  for (const f of readdirSync(svgDir).sort()) {
    if (!f.startsWith("emoji-") || !f.endsWith(".svg")) continue;
    const slug = f.slice("emoji-".length, -".svg".length);
    const svg = readFileSync(join(svgDir, f), "utf8");
    const glyph = parseGlyph(svg);
    if (!glyph) {
      if (!/<text\b/.test(svg)) {
        throw new Error(`Не удалось прочитать глиф ${f}`);
      }
      skipped.push(slug);
      continue;
    }
    // Path data не содержит кавычек/бэкслешей — проверка на всякий случай.
    if (/["\\]/.test(glyph.d) || /["\\]/.test(glyph.vb)) {
      console.error(`Небезопасные символы в ${f}`);
      process.exit(1);
    }
    entries.push(`  "${slug}": { vb: "${glyph.vb}", d: "${glyph.d}" }`);
  }
  const body = `// СГЕНЕРИРОВАНО scripts/gen-emoji-glyphs.mjs — не править руками.
// Инлайн-пути глифов Mojangles (viewBox + path data), ключ — слаг MC_EMOJI.
// McEmoji рисует путь инлайн с цветом текста или бейджа. Глифы-фолбэки
// (<text>) здесь отсутствуют: McEmoji рисует их символом.
export const EMOJI_GLYPHS: Record<string, { vb: string; d: string }> = {
${entries.join(",\n")},
};
`;
  writeFileSync(out, body);
  report.push(`${out}: ${entries.length} глифов, пропущено (text): ${skipped.length} [${skipped.join(", ")}]`);
}
console.log(report.join("\n"));
