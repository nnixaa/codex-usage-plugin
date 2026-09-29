import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
export function cacheDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "codex-usage-plugin");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "codex-usage-plugin");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "codex-usage-plugin");
}

// Several plugin servers (one per open thread) share the cache files.
export async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}
