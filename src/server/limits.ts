// Rate limits via `codex app-server` (account/rateLimits/read), so the plugin never
// touches Codex credentials. Codex starts one plugin server per open thread, so the
// result is shared through a cache file and the app-server child exits soon after use.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { cacheDir, writeAtomic } from "./paths.js";

declare const __VERSION__: string;

export type LimitWindow = {
  label: string;
  usedPercent: number;
  windowMins: number | null;
  resetsAt: number | null;
  // Share of the window that has elapsed, to compare against usedPercent.
  elapsedPercent: number | null;
};
export type ResetCredit = { title: string | null; expiresAt: number | null };
export type Limits = {
  plan: string | null;
  windows: LimitWindow[];
  resetCredits: number | null;
  resetCreditList: ResetCredit[];
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  limitReached: string | null;
  ordinaryUsageAllowed: boolean | null;
  fetchedAt: number;
};

const CANDIDATES = [
  process.env.CODEX_USAGE_BIN,
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];
const IDLE_MS = 15_000;
const TIMEOUT_MS = 20_000;
const FRESH_MS = 30_000;

let child: ChildProcessWithoutNullStreams | null = null;
let ready: Promise<void> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let last: Limits | null = null;
let inflight: Promise<Limits> | null = null;

function codexBinary(): string {
  return CANDIDATES.find((path) => path && existsSync(path)) ?? "codex";
}

function stop(): void {
  child?.kill();
  child = null;
  ready = null;
  for (const { reject } of pending.values()) reject(new Error("codex app-server stopped"));
  pending.clear();
}

function request(method: string, params?: unknown): Promise<any> {
  if (!child) return Promise.reject(new Error("codex app-server is not running"));
  const id = ++nextId;
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, TIMEOUT_MS);
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
  });
}

function start(): Promise<void> {
  if (ready) return ready;
  // On Windows the PATH fallback is `codex.cmd`, which needs a shell.
  const proc = spawn(codexBinary(), ["app-server"], { stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
  child = proc;
  proc.stderr.resume();
  proc.on("error", stop);
  proc.on("exit", () => {
    if (child === proc) stop();
  });
  createInterface({ input: proc.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = message.id != null ? pending.get(message.id) : undefined;
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "app-server error"));
    else waiter.resolve(message.result);
  });
  ready = request("initialize", {
    clientInfo: { name: "codex-usage-plugin", title: "Usage", version: __VERSION__ },
    capabilities: null,
  }).then(() => {
    proc.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  });
  ready.catch(stop);
  return ready;
}

function windowLabel(mins: number | null): string {
  if (mins == null) return "Limit";
  if (mins === 10080) return "Weekly";
  if (mins === 300) return "Session";
  if (mins % 1440 === 0) return `${mins / 1440}-day`;
  if (mins % 60 === 0) return `${mins / 60}-hour`;
  return `${mins}-min`;
}

function toWindow(raw: any, prefix = ""): LimitWindow | null {
  if (!raw) return null;
  const windowMins = raw.windowDurationMins ?? null;
  const resetsAt = raw.resetsAt ?? null;
  let elapsedPercent: number | null = null;
  if (windowMins && resetsAt) {
    const left = resetsAt * 1000 - Date.now();
    elapsedPercent = Math.min(100, Math.max(0, 100 - (left / (windowMins * 60_000)) * 100));
  }
  return { label: prefix + windowLabel(windowMins), usedPercent: raw.usedPercent ?? 0, windowMins, resetsAt, elapsedPercent };
}

async function fetchLimits(): Promise<Limits> {
  await start();
  const result = await request("account/rateLimits/read", { excludeResetCreditDetails: false });
  const byId: Record<string, any> = result?.rateLimitsByLimitId ?? {};
  const snapshot = byId.codex ?? result?.rateLimits ?? {};
  const bySize = (a: LimitWindow, b: LimitWindow) => (a.windowMins ?? 0) - (b.windowMins ?? 0);
  const windowsOf = (s: any, prefix = "") =>
    [toWindow(s?.primary, prefix), toWindow(s?.secondary, prefix)].filter((w): w is LimitWindow => w != null).sort(bySize);
  // Model-specific buckets (e.g. Spark) come as extra limit ids next to `codex`.
  const extra = Object.entries(byId)
    .filter(([id]) => id !== "codex")
    .flatMap(([id, s]) => windowsOf(s, `${s?.limitName ?? id} · `));
  const credits = result?.rateLimitResetCredits;
  return {
    plan: snapshot.planType ?? null,
    windows: [...windowsOf(snapshot), ...extra],
    resetCredits: credits?.availableCount != null ? Number(credits.availableCount) : null,
    resetCreditList: (credits?.credits ?? [])
      .filter((c: any) => c.status === "available")
      .map((c: any) => ({ title: c.title ?? null, expiresAt: c.expiresAt ?? null }))
      .sort((a: ResetCredit, b: ResetCredit) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)),
    credits: snapshot.credits ?? null,
    limitReached: snapshot.rateLimitReachedType ?? null,
    ordinaryUsageAllowed: result?.ordinaryUsageAllowed ?? null,
    fetchedAt: Date.now(),
  };
}

const SHARED_FILE = () => join(cacheDir(), "limits.json");
const fresh = (limits: Limits | null): limits is Limits => limits != null && Date.now() - limits.fetchedAt < FRESH_MS;

async function readShared(): Promise<Limits | null> {
  try {
    return JSON.parse(await readFile(SHARED_FILE(), "utf8"));
  } catch {
    return null;
  }
}

export async function readLimits(force = false): Promise<Limits> {
  if (!force) {
    if (fresh(last)) return last;
    const shared = await readShared();
    if (fresh(shared)) return (last = shared);
  }
  inflight ??= fetchLimits()
    .then(async (limits) => {
      last = limits;
      await writeAtomic(SHARED_FILE(), JSON.stringify(limits)).catch(() => {});
      return limits;
    })
    .finally(() => {
      inflight = null;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(stop, IDLE_MS);
      idleTimer.unref();
    });
  return inflight;
}

export function shutdownLimits(): void {
  stop();
}
