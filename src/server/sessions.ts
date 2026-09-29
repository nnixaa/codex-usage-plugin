// Daily token totals from Codex rollout logs (~/.codex/sessions, ~/.codex/archived_sessions).
// Rollouts are append-only JSONL, so each file is scanned once and then read
// incrementally from the last complete line. Results are cached on disk.
import { open, readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir, codexHome, writeAtomic } from "./paths.js";

export type DayTotals = { total: number; cached: number; output: number };
export type DailyUsage = { date: string; total: number; cached: number; output: number }[];

type FileEntry = {
  size: number;
  offset: number;
  days: Record<string, DayTotals>;
};
type Cache = { version: 1; files: Record<string, FileEntry> };

const MARKER = Buffer.from('"type":"token_count"');
const NEWLINE = 0x0a;
const CHUNK = 8 * 1024 * 1024;
const CACHE_FILE = () => join(cacheDir(), "daily-v1.json");

let cache: Cache | null = null;
let running: Promise<DailyUsage> | null = null;

export function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function loadCache(): Promise<Cache> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await readFile(CACHE_FILE(), "utf8"));
    if (parsed?.version === 1) cache = parsed;
  } catch {}
  cache ??= { version: 1, files: {} };
  return cache;
}

async function saveCache(): Promise<void> {
  if (!cache) return;
  await writeAtomic(CACHE_FILE(), JSON.stringify(cache));
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

function addEvent(line: Buffer, days: Record<string, DayTotals>): void {
  let event;
  try {
    event = JSON.parse(line.toString("utf8"));
  } catch {
    return;
  }
  const last = event?.payload?.info?.last_token_usage;
  const ts = Date.parse(event?.timestamp);
  if (!last || !Number.isFinite(ts)) return;
  const day = (days[localDate(ts)] ??= { total: 0, cached: 0, output: 0 });
  day.total += last.total_tokens ?? 0;
  day.cached += last.cached_input_tokens ?? 0;
  day.output += last.output_tokens ?? 0;
}

// Reads `path` from `offset`, adding every complete token_count line to `days`.
// Returns the offset just past the last complete line.
async function scanFrom(path: string, offset: number, days: Record<string, DayTotals>): Promise<number> {
  const handle = await open(path, "r");
  try {
    let position = offset;
    let carry: Buffer = Buffer.alloc(0);
    const chunk = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const end = data.lastIndexOf(NEWLINE);
      if (end < 0) {
        carry = Buffer.from(data);
        continue;
      }
      const complete = data.subarray(0, end + 1);
      let at = complete.indexOf(MARKER);
      while (at >= 0) {
        const start = complete.lastIndexOf(NEWLINE, at) + 1;
        const stop = complete.indexOf(NEWLINE, at);
        addEvent(complete.subarray(start, stop), days);
        at = complete.indexOf(MARKER, stop);
      }
      carry = Buffer.from(data.subarray(end + 1));
    }
    return position - carry.length;
  } finally {
    await handle.close();
  }
}

async function refresh(daysBack: number): Promise<DailyUsage> {
  const state = await loadCache();
  const home = codexHome();
  const since = Date.now() - (daysBack + 1) * 86_400_000;
  const seen = new Set<string>();
  let changed = false;

  for (const root of [join(home, "sessions"), join(home, "archived_sessions")]) {
    for await (const path of walk(root)) {
      let info;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (info.mtimeMs < since) continue;
      seen.add(path);
      let entry = state.files[path];
      if (!entry || info.size < entry.offset) {
        entry = { size: 0, offset: 0, days: {} };
        state.files[path] = entry;
      }
      if (info.size === entry.size) continue;
      entry.offset = await scanFrom(path, entry.offset, entry.days);
      entry.size = info.size;
      changed = true;
    }
  }

  // Archiving moves a rollout; drop entries whose file is gone or out of range.
  for (const path of Object.keys(state.files)) {
    if (!seen.has(path)) {
      delete state.files[path];
      changed = true;
    }
  }
  if (changed) await saveCache();

  const totals = new Map<string, DayTotals>();
  for (const entry of Object.values(state.files)) {
    for (const [date, day] of Object.entries(entry.days)) {
      const sum = totals.get(date) ?? { total: 0, cached: 0, output: 0 };
      sum.total += day.total;
      sum.cached += day.cached;
      sum.output += day.output;
      totals.set(date, sum);
    }
  }
  const result: DailyUsage = [];
  for (let i = daysBack - 1; i >= 0; i--) {
    const date = localDate(Date.now() - i * 86_400_000);
    result.push({ date, ...(totals.get(date) ?? { total: 0, cached: 0, output: 0 }) });
  }
  return result;
}

export function dailyUsage(daysBack = 14): Promise<DailyUsage> {
  running ??= refresh(daysBack).finally(() => {
    running = null;
  });
  return running;
}
