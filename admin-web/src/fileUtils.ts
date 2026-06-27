export const KINDS = ["mod", "config", "resource", "other"];
export const SIDES = ["both", "client", "server"];

export function guessKind(path: string): string {
  const n = path.toLowerCase();
  if (n.endsWith(".jar")) return "mod";
  if (n.endsWith(".zip")) return "resource";
  if (
    n.startsWith("config/") ||
    n.endsWith(".toml") ||
    n.endsWith(".json") ||
    n.endsWith(".cfg") ||
    n.endsWith(".properties")
  )
    return "config";
  return "other";
}
