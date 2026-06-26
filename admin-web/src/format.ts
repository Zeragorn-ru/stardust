// Мелкие утилиты форматирования, общие для всей админки.

/// Человекочитаемый размер: 1536 → "1.5 KB".
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/// Короткий sha1 для отображения (первые 10 символов).
export function shortSha(sha1: string): string {
  return sha1.slice(0, 10);
}

/// Имя файла из пути: "mods/sodium.jar" → "sodium.jar".
export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

/// Нормализует путь каталога: убирает ведущие/повторные/висячие слэши.
/// "/mods//" → "mods", "" → "".
export function normalizeDir(dir: string): string {
  return dir
    .split("/")
    .filter((s) => s.length > 0)
    .join("/");
}

/// Родительский каталог: "config/foo/bar" → "config/foo", "mods" → "".
export function parentDir(dir: string): string {
  const norm = normalizeDir(dir);
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(0, i) : "";
}
