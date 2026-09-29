import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import type { OpenAIUiResourceMetadata } from "@openai/mcp-extensions/server";
import { z } from "zod/v4";
import { readLimits, shutdownLimits, type Limits } from "./limits.js";
import { dailyUsage, type DailyUsage } from "./sessions.js";
import { currentThread, neighborThreads, topThreads, type ThreadUsage } from "./threads.js";
import { serviceStatus, type ServiceStatus } from "./status.js";

type View = "panel" | "dashboard" | "inline";
export type Snapshot = {
  view: View;
  limits: Limits | null;
  limitsError: string | null;
  thread: ThreadUsage | null;
  // True when the host named the calling thread; otherwise `thread` is the latest active one.
  threadIsCurrent: boolean;
  // Other recently active threads from the same project, newest first.
  recent: ThreadUsage[] | null;
  project: string | null;
  daily: DailyUsage | null;
  status: ServiceStatus | null;
  top: ThreadUsage[] | null;
  generatedAt: number;
};

declare const __VERSION__: string;
const UI = "ui://usage/app-v3";
const DAILY_BUDGET_MS = 1500;
const RECENT_THREADS = 6;
// Read per request so rebuilds show up without restarting Codex, which keeps this server
// running across reinstalls; fall back to the last copy once a reinstall removes this version.
let lastHtml = await readFile(new URL("./app.html", import.meta.url), "utf8");
async function appHtml(): Promise<string> {
  try {
    lastHtml = await readFile(new URL("./app.html", import.meta.url), "utf8");
  } catch {}
  return lastHtml;
}
const iconSvg = await readFile(new URL("../assets/icon.svg", import.meta.url), "utf8");
const icon = { src: "data:image/svg+xml," + encodeURIComponent(iconSvg), mimeType: "image/svg+xml", sizes: ["any"] };

// The SDK's registerTool has no per-tool icons, so entrypoints fall back to the server icon.

// Codex sends the calling thread as `threadId` (and `thread_id`) in request _meta.
function threadIdFrom(meta: Record<string, unknown> | undefined): string | undefined {
  for (const key of ["threadId", "thread_id"]) {
    if (typeof meta?.[key] === "string") return meta[key] as string;
  }
  return undefined;
}

function withBudget<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

async function snapshot(view: View, threadId: string | undefined, force = false): Promise<Snapshot> {
  const daily = dailyUsage(30);
  daily.catch(() => {});
  const [limits, thread, status] = await Promise.allSettled([readLimits(force), currentThread(threadId), serviceStatus()]);
  const current = thread.status === "fulfilled" ? thread.value : null;
  const neighbors = view === "inline" ? null : await neighborThreads(RECENT_THREADS, current).catch(() => null);
  const weekAgo = Date.now() - 7 * 86_400_000;
  return {
    view,
    limits: limits.status === "fulfilled" ? limits.value : null,
    limitsError: limits.status === "rejected" ? String(limits.reason?.message ?? limits.reason) : null,
    thread: current,
    threadIsCurrent: threadId != null && current?.id === threadId,
    recent: neighbors?.threads ?? null,
    project: neighbors?.project ?? null,
    // The first scan of rollout logs takes a few seconds; don't block the first paint on it.
    daily: await withBudget(daily, view === "dashboard" ? 15_000 : DAILY_BUDGET_MS).catch(() => null),
    status: status.status === "fulfilled" ? status.value : null,
    top: view === "dashboard" ? await topThreads(weekAgo).catch(() => null) : null,
    generatedAt: Date.now(),
  };
}

const fmt = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

function resetText(resetsAt: number | null): string {
  if (!resetsAt) return "";
  const mins = Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  return `resets in ${d ? `${d}d ` : ""}${h}h ${mins % 60}m`;
}

function summary(s: Snapshot): string {
  const lines: string[] = [];
  if (s.limits) {
    lines.push(`Codex plan: ${s.limits.plan ?? "unknown"}`);
    for (const w of s.limits.windows) {
      lines.push(`${w.label} limit: ${w.usedPercent}% used, ${resetText(w.resetsAt)} (${Math.round(w.elapsedPercent ?? 0)}% of window elapsed)`);
    }
    if (s.limits.resetCredits != null) lines.push(`Limit reset credits available: ${s.limits.resetCredits}`);
    if (s.limits.credits?.hasCredits) lines.push(`Credits balance: ${s.limits.credits.balance}`);
    if (s.limits.limitReached) lines.push(`Limit reached: ${s.limits.limitReached}`);
  } else {
    lines.push(`Rate limits unavailable: ${s.limitsError}`);
  }
  if (s.thread) {
    const ctx = s.thread.contextWindow ? `, context ${fmt(s.thread.contextUsed ?? 0)}/${fmt(s.thread.contextWindow)}` : "";
    lines.push(`Thread "${s.thread.title}": ${fmt(s.thread.tokens)} tokens${ctx}`);
  }
  const today = s.daily?.at(-1);
  if (today) lines.push(`Tokens today: ${fmt(today.total)} (${fmt(today.output)} output)`);
  if (s.status && s.status.indicator !== "none") {
    lines.push(`OpenAI status: ${s.status.description}${s.status.incidents.length ? ` — ${s.status.incidents.join("; ")}` : ""}`);
  }
  return lines.join("\n");
}

const result = (s: Snapshot) => ({
  content: [{ type: "text" as const, text: summary(s) }],
  structuredContent: s as unknown as Record<string, unknown>,
});
const readonly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const ui = (entrypoints: unknown[] = [], visibility?: string[]) => ({
  ui: { resourceUri: UI, ...(visibility ? { visibility } : {}) },
  "openai/ui": { entrypoints },
  "openai/iconStyle": "monochrome",
});

const server = new McpServer({
  name: "usage",
  title: "Usage",
  version: __VERSION__,
  icons: [icon],
});

registerAppResource(server, "Usage", UI, {}, async () => ({
  contents: [
    {
      uri: UI,
      mimeType: RESOURCE_MIME_TYPE,
      text: await appHtml(),
      _meta: {
        "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] } satisfies OpenAIUiResourceMetadata,
      },
    },
  ],
}));

server.registerTool(
  "usage.panel",
  {
    title: "Usage",
    description: "Open Codex usage limits beside this conversation.",
    inputSchema: z.object({}),
    annotations: readonly,
    _meta: ui([{ type: "thread" }], ["app"]),
  },
  async (_args, extra) => result(await snapshot("panel", threadIdFrom(extra._meta))),
);

server.registerTool(
  "usage.dashboard",
  {
    title: "Usage",
    description: "Open the Codex usage dashboard.",
    inputSchema: z.object({}),
    annotations: readonly,
    _meta: ui([{ type: "global" }], ["app"]),
  },
  async (_args, extra) => result(await snapshot("dashboard", threadIdFrom(extra._meta))),
);

server.registerTool(
  "usage.show",
  {
    title: "Show Codex usage",
    description:
      "Show the user's Codex usage: rate-limit windows (percent used, time to reset), reset credits, tokens used by this thread and today. Use when the user asks about usage, limits, quota, or how much is left.",
    inputSchema: z.object({}),
    annotations: readonly,
    _meta: ui(),
  },
  async (_args, extra) => result(await snapshot("inline", threadIdFrom(extra._meta))),
);

server.registerTool(
  "usage.refresh",
  {
    title: "Refresh usage",
    inputSchema: z.object({
      view: z.enum(["panel", "dashboard", "inline"]).default("panel"),
      force: z.boolean().default(false),
      threadId: z.string().optional(),
    }),
    annotations: readonly,
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ view, force, threadId }, extra) =>
    result(await snapshot(view, threadId ?? threadIdFrom(extra._meta), force)),
);

process.on("SIGTERM", () => {
  shutdownLimits();
  process.exit(0);
});
process.stdin.on("close", shutdownLimits);
await server.connect(new StdioServerTransport());
