// Общие утилиты форматирования.

/// Человекочитаемый размер файла (Б, КБ, МБ, ГБ).
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

/** Русская плюрализация: 1 мод / 2-4 мода / 5+ модов, включая 21 мод. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  if (n % 100 >= 11 && n % 100 <= 14) return many;
  if (n % 10 === 1) return one;
  if (n % 10 >= 2 && n % 10 <= 4) return few;
  return many;
}

/// Компактное число для счётчиков: 940 / 1.2k / 3.4M.
export function formatCompact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
