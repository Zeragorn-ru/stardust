#!/usr/bin/env node
// Патч @daidr/minecraft-skin-renderer: сохраняем полупрозрачность outer layer.
// Библиотека принудительно ставит texColor.a = 1.0 для outer layer,
// что убивает полупрозрачные пиксели второго слоя скина.
// Скрипт корректирует шейдеры (WebGL + WebGPU), чтобы alpha оставался оригинальным.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const base = resolve(__dirname, "../node_modules/@daidr/minecraft-skin-renderer/dist");

const patches = [
  {
    file: "core/renderer/webgl/shaders/raw.js",
    // WebGL GLSL: replace texColor.a = 1.0 in outer layer block
    find: /if \(texColor\.a > 0\.001\) \{\n\t\t\ttexColor\.rgb \/= texColor\.a;\n\t\t\}\n\t\ttexColor\.a = 1\.0;/,
    replace: `if (texColor.a > 0.001) {
			texColor.rgb /= texColor.a;
		}
		// Keep original alpha for semi-transparent outer layer pixels`,
  },
  {
    file: "core/renderer/webgpu/shaders/raw.js",
    // WebGPU WGSL: replace texColor.a = 1.0 in outer layer block
    find: /if \(texColor\.a > 0\.001\) \{\n      texColor = vec4<f32>\(texColor\.rgb \/ texColor\.a, texColor\.a\);\n    \}\n    texColor\.a = 1\.0;/,
    replace: `if (texColor.a > 0.001) {
      texColor = vec4<f32>(texColor.rgb / texColor.a, texColor.a);
    }
    // Keep original alpha for semi-transparent outer layer pixels`,
  },
];

let patched = 0;
for (const { file, find, replace } of patches) {
  const path = resolve(base, file);
  const src = readFileSync(path, "utf8");
  const out = src.replace(find, replace);
  if (out !== src) {
    writeFileSync(path, out, "utf8");
    patched++;
    console.log(`[patch-skin-renderer] patched ${file}`);
  }
}

if (patched === 0) {
  console.log("[patch-skin-renderer] shaders already patched or patterns not found");
}
