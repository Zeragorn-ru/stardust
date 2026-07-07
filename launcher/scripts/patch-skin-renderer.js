#!/usr/bin/env node
// Патч @daidr/minecraft-skin-renderer: сохраняем полупрозрачность outer layer.
// Библиотека принудительно ставит texColor.a = 1.0 для outer layer,
// что убивает полупрозрачные пиксели второго слоя скина (очки и т.п.).
// Скрипт корректирует шейдеры (WebGL + WebGPU), чтобы alpha оставался оригинальным.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const base = resolve(__dirname, "../node_modules/@daidr/minecraft-skin-renderer/dist");

const MARKER = "// Keep original alpha for semi-transparent outer layer pixels";

const patches = [
  {
    file: "core/renderer/webgl/shaders/raw.js",
    // WebGL GLSL: remove forced alpha=1 in outer layer block (whitespace-agnostic).
    find: /if \(texColor\.a > 0\.001\) \{\s*texColor\.rgb \/= texColor\.a;\s*\}\s*texColor\.a = 1\.0;/,
    replace: `if (texColor.a > 0.001) {
            texColor.rgb /= texColor.a;
        }
        ${MARKER}`,
  },
  {
    file: "core/renderer/webgpu/shaders/raw.js",
    // WebGPU WGSL: same fix for outer layer block.
    find: /if \(texColor\.a > 0\.001\) \{\s*texColor = vec4<f32>\(texColor\.rgb \/ texColor\.a, texColor\.a\);\s*\}\s*texColor\.a = 1\.0;/,
    replace: `if (texColor.a > 0.001) {
      texColor = vec4<f32>(texColor.rgb / texColor.a, texColor.a);
    }
    ${MARKER}`,
  },
];

let patched = 0;
for (const { file, find, replace } of patches) {
  const path = resolve(base, file);
  if (!existsSync(path)) {
    console.warn(`[patch-skin-renderer] skip missing ${file}`);
    continue;
  }
  const src = readFileSync(path, "utf8");
  if (src.includes(MARKER)) {
    console.log(`[patch-skin-renderer] already patched ${file}`);
    continue;
  }
  const out = src.replace(find, replace);
  if (out === src) {
    console.warn(`[patch-skin-renderer] pattern not found in ${file}`);
    continue;
  }
  writeFileSync(path, out, "utf8");
  patched++;
  console.log(`[patch-skin-renderer] patched ${file}`);
}

if (patched === 0) {
  console.log("[patch-skin-renderer] no files changed");
}
