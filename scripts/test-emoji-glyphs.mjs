// Проверка соответствия инлайн-контуров исходным SVG и индексу эмодзи.
// Запуск: node --test scripts/test-emoji-glyphs.mjs
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

for (const [app, indexPath, glyphsPath] of [
  ["launcher", "src/emoji.ts", "src/emojiGlyphs.ts"],
  ["admin-web", "src/emoji/index.ts", "src/emoji/glyphs.ts"],
]) {
  test(`${app}: контуры соответствуют индексу и SVG`, () => {
    const dir = join(root, app);
    const index = readFileSync(join(dir, indexPath), "utf8");
    const generated = readFileSync(join(dir, glyphsPath), "utf8");
    const glyphs = new Map([...generated.matchAll(/^  "([^"]+)": \{ vb: "([^"]+)", d: "([^"]+)" \}/gm)]
      .map(([, slug, vb, path]) => [slug, { vb, path }]));
    const files = [...index.matchAll(/file: "emoji\/emoji-([^"]+)\.svg"/g)];
    assert.ok(files.length > 0, "индекс эмодзи пуст");
    for (const [, slug] of files) {
      const svg = readFileSync(join(dir, "public/emoji", `emoji-${slug}.svg`), "utf8");
      if (/<text\b/.test(svg)) {
        assert.equal(glyphs.has(slug), false, `${slug}: текстовый фолбэк`);
        continue;
      }
      const vb = svg.match(/viewBox="([^"]+)"/)?.[1];
      const path = svg.match(/<path[^>]*\sd="([^"]+)"/)?.[1];
      assert.ok(vb && path, `${slug}: нет контура в SVG`);
      assert.deepEqual(glyphs.get(slug), { vb, path }, `${slug}: устаревший контур`);
    }
  });
}
