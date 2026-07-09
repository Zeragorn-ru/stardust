/**
 * Нормализация PNG-скина перед 3D-превью.
 *
 * @daidr/minecraft-skin-renderer на внутреннем слое принудительно делает все
 * пиксели непрозрачными (alpha=0 → чёрный). Ванильный клиент перед этим
 * обнуляет альфу во внутренних регионах и оставляет cutout только на втором
 * слое — см. SkinTextureDownloader в Minecraft и normalize_skin_texture в Modrinth.
 */

type Rect = readonly [x1: number, y1: number, x2: number, y2: number];

/** Регионы базового слоя, которые ваниль делает полностью непрозрачными. */
const OPAQUE_INNER_PARTS: readonly Rect[] = [
  [0, 0, 32, 16],
  [0, 16, 64, 32],
  [16, 48, 48, 64],
];

/** Копирование граней при конвертации legacy 64×32 → 64×64. */
const LEGACY_FACE_COPY: readonly (readonly [number, number, number, number, number, number])[] = [
  [4, 16, 16, 32, 4, 4],
  [8, 16, 16, 32, 4, 4],
  [0, 20, 24, 32, 4, 12],
  [4, 20, 16, 32, 4, 12],
  [8, 20, 8, 32, 4, 12],
  [12, 20, 16, 32, 4, 12],
  [44, 16, -8, 32, 4, 4],
  [48, 16, -8, 32, 4, 4],
  [40, 20, 0, 32, 4, 12],
  [44, 20, -8, 32, 4, 12],
  [48, 20, -16, 32, 4, 12],
  [52, 20, -8, 32, 4, 12],
];

const cache = new Map<string, string>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to load skin image"));
    img.src = src;
  });
}

function setAlpha(
  data: Uint8ClampedArray,
  width: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  alpha: number,
): void {
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      data[(y * width + x) * 4 + 3] = alpha;
    }
  }
}

function copyRectMirror(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  offX: number,
  offY: number,
  regionW: number,
  regionH: number,
): void {
  for (let row = 0; row < regionH; row++) {
    for (let col = 0; col < regionW; col++) {
      const srcX = x + col;
      const srcY = y + row;
      const dstX = x + offX + (regionW - 1 - col);
      const dstY = y + offY + row;
      const srcIdx = (srcY * width + srcX) * 4;
      const dstIdx = (dstY * width + dstX) * 4;
      data[dstIdx] = data[srcIdx];
      data[dstIdx + 1] = data[srcIdx + 1];
      data[dstIdx + 2] = data[srcIdx + 2];
      data[dstIdx + 3] = data[srcIdx + 3];
    }
  }
}

function convertLegacySkin(data: Uint8ClampedArray, width: number): void {
  const scale = width / 64;
  for (const [x, y, offX, offY, regionW, regionH] of LEGACY_FACE_COPY) {
    copyRectMirror(
      data,
      width,
      Math.round(x * scale),
      Math.round(y * scale),
      Math.round(offX * scale),
      Math.round(offY * scale),
      Math.round(regionW * scale),
      Math.round(regionH * scale),
    );
  }
}

/** Notch transparency hack: полностью непрозрачная «шляпа» → делаем её прозрачной. */
function notchTransparencyHack(data: Uint8ClampedArray, width: number): void {
  const scale = width / 64;
  const x1 = Math.round(32 * scale);
  const y1 = 0;
  const x2 = width;
  const y2 = Math.round(32 * scale);

  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      if (data[(y * width + x) * 4 + 3] < 128) return;
    }
  }

  setAlpha(data, width, x1, y1, x2, y2, 0);
}

function makeInnerPartsOpaque(data: Uint8ClampedArray, width: number): void {
  const scale = width / 64;
  for (const [x1, y1, x2, y2] of OPAQUE_INNER_PARTS) {
    setAlpha(
      data,
      width,
      Math.round(x1 * scale),
      Math.round(y1 * scale),
      Math.round(x2 * scale),
      Math.round(y2 * scale),
      255,
    );
  }
}

function normalizePixels(imageData: ImageData, isLegacy: boolean): void {
  const { data, width, height } = imageData;

  if (isLegacy) {
    // Нижняя половина legacy-скина должна быть прозрачной до копирования граней.
    setAlpha(data, width, 0, height / 2, width, height, 0);
    convertLegacySkin(data, width);
    notchTransparencyHack(data, width);
  }

  makeInnerPartsOpaque(data, width);
}

function readPixels(img: HTMLImageElement): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}

function toDataUrl(imageData: ImageData): string {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d unavailable");
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Подготавливает data-URL скина для 3D-рендера. Результат кэшируется по входной строке.
 */
export async function normalizeSkinForViewer(source: string): Promise<string> {
  const cached = cache.get(source);
  if (cached) return cached;

  const img = await loadImage(source);
  const width = img.width;
  const height = img.height;
  const isLegacy = height * 2 === width;
  const isSquare = width === height;

  // Нестандартный формат: только roundtrip через canvas для корректной альфы.
  if ((!isSquare && !isLegacy) || width % 64 !== 0) {
    const roundtrip = toDataUrl(readPixels(img));
    cache.set(source, roundtrip);
    return roundtrip;
  }

  const imageData = readPixels(img);
  let pixels: ImageData;

  if (isLegacy) {
    pixels = new ImageData(width, width);
    pixels.data.set(imageData.data.subarray(0, width * height * 4));
  } else {
    pixels = imageData;
  }

  normalizePixels(pixels, isLegacy);
  const normalized = toDataUrl(pixels);
  cache.set(source, normalized);
  return normalized;
}

/** Сбрасывает кэш (например, при выгрузке нового файла с тем же data URL не нужен). */
export function clearSkinNormalizeCache(): void {
  cache.clear();
}
