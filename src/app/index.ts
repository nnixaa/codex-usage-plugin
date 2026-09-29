import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import type { Snapshot } from "../server/index.js";

type View = Snapshot["view"];
type Limits = NonNullable<Snapshot["limits"]>;
type LimitWindow = Limits["windows"][number];
type Day = NonNullable<Snapshot["daily"]>[number];
type ThreadUsage = NonNullable<Snapshot["thread"]>;

const REFRESH_MS = 60_000;
const TICK_MS = 30_000;

const app = new App({ name: "usage", version: "0.2.0" });
new OpenAIExtensions(app);
const root = document.getElementById("usage-app")!;
let state: Snapshot | null = null;
let loading = false;

// ---------- formatting ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const tokens = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);

function span(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function updatedText(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  return mins < 1 ? "Updated just now" : `Updated ${mins}m ago`;
}

function ago(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const shortDate = (sec: number) => new Date(sec * 1000).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });

// ---------- pace ----------

type Pace = { text: string; tone: "muted" | "warn" };

// Compares usage with the share of the window that has elapsed and projects
// whether the current rate lasts until reset.
function pace(w: LimitWindow): Pace | null {
  if (w.elapsedPercent == null || w.windowMins == null || w.resetsAt == null) return null;
  const windowMs = w.windowMins * 60_000;
  const elapsedMs = (w.elapsedPercent / 100) * windowMs;
  const leftMs = w.resetsAt * 1000 - Date.now();
  if (elapsedMs < windowMs * 0.02 || leftMs <= 0) return null;
  const delta = Math.round(w.usedPercent - w.elapsedPercent);
  const side = delta <= 0 ? `${Math.abs(delta)}% under` : `${delta}% over`;
  if (w.usedPercent <= 0) return { text: `Pace: ${side} · Lasts to reset`, tone: "muted" };
  const msToFull = ((100 - w.usedPercent) / w.usedPercent) * elapsedMs;
  return msToFull >= leftMs
    ? { text: `Pace: ${side} · Lasts to reset`, tone: "muted" }
    : { text: `Pace: ${side} · Runs out in ${span(msToFull)}`, tone: "warn" };
}

function tone(w: LimitWindow): "" | "warn" | "danger" {
  if (w.usedPercent >= 95) return "danger";
  if (w.usedPercent >= 80 || pace(w)?.tone === "warn") return "warn";
  return "";
}

// ---------- sections ----------

function header(s: Snapshot | null): string {
  const plan = s?.limits?.plan ? `<span class="plan">${esc(s.limits.plan[0].toUpperCase() + s.limits.plan.slice(1))}</span>` : "";
  return `
    <header class="head">
      <div class="head-row">
        <div class="head-title"><h1>Codex Usage</h1>${plan}</div>
        <button class="icon-btn ${loading ? "spin" : ""}" type="button" data-action="refresh" title="Refresh" aria-label="Refresh">
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6"/><path d="M16.5 3.5v3.2h-3.2"/></svg>
        </button>
      </div>
      <div class="sub updated">${s ? updatedText(s.generatedAt) : "Loading…"}</div>
    </header>`;
}

function limitRow(w: LimitWindow, withPace = true): string {
  const used = Math.min(100, Math.max(0, w.usedPercent));
  const p = withPace ? pace(w) : null;
  const tick = w.elapsedPercent != null ? `<i class="tick" style="left:${w.elapsedPercent.toFixed(1)}%" title="Even-use guide: ${Math.round(w.elapsedPercent)}% of the window has passed"></i>` : "";
  const resets = w.resetsAt ? `Resets in ${span(w.resetsAt * 1000 - Date.now())}` : "";
  return `
    <div class="metric">
      <div class="label">${esc(w.label)}</div>
      <div class="bar ${tone(w)}"><b style="width:${used}%"></b>${tick}</div>
      <div class="row"><span>${Math.round(used)}% used</span><span class="sub">${resets}</span></div>
      ${p ? `<div class="pace ${p.tone}">${p.text}</div>` : ""}
    </div>`;
}

function limitsSection(s: Snapshot, compact = false): string {
  if (!s.limits) return `<section class="block"><div class="notice">Limits unavailable${s.limitsError ? ` · ${esc(s.limitsError)}` : ""}</div></section>`;
  const l = s.limits;
  const reached = l.limitReached ? `<div class="notice danger">Limit reached · ${esc(l.limitReached)}</div>` : "";
  return `<section class="block">${reached}${l.windows.map((w) => limitRow(w, !compact)).join("")}</section>`;
}

function creditsSection(l: Limits): string {
  const rows: string[] = [];
  if (l.resetCredits) {
    const next = l.resetCreditList.find((c) => c.expiresAt != null);
    rows.push(`
      <div class="metric">
        <div class="row"><span class="label">Limit resets</span><span>${l.resetCredits} available</span></div>
        ${next ? `<div class="row sub"><span>Next expires ${shortDate(next.expiresAt!)}</span><span>in ${span(next.expiresAt! * 1000 - Date.now())}</span></div>` : ""}
      </div>`);
  }
  if (l.credits?.unlimited) rows.push(`<div class="metric"><div class="row"><span class="label">Credits</span><span>Unlimited</span></div></div>`);
  else if (l.credits?.hasCredits) rows.push(`<div class="metric"><div class="row"><span class="label">Credits</span><span>${esc(String(l.credits.balance))}</span></div></div>`);
  return rows.length ? `<section class="block">${rows.join("")}</section>` : "";
}

function sum(days: Day[], n: number): number {
  return days.slice(-n).reduce((total, d) => total + d.total, 0);
}

function bars(days: Day[], tall = false): string {
  const max = Math.max(1, ...days.map((d) => d.total));
  const cols = days
    .map((d, i) => {
      const h = d.total ? Math.max(3, (d.total / max) * 100) : 0;
      const label = new Date(d.date + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric" });
      return `<i class="${i === days.length - 1 ? "today" : ""}" style="height:${h}%" title="${label}: ${tokens(d.total)} tokens · ${tokens(d.output)} output"></i>`;
    })
    .join("");
  return `<div class="bars ${tall ? "tall" : ""}">${cols}</div>`;
}

function tokensSection(s: Snapshot, chart: "mini" | "tall" | "none" = "mini"): string {
  if (!s.daily) return `<section class="block"><div class="label">Tokens</div><div class="row sub"><span>Reading session logs…</span></div></section>`;
  const days = s.daily;
  const today = days.at(-1)!;
  const first = new Date(days[0].date + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric" });
  return `
    <section class="block">
      <div class="label">Tokens</div>
      <div class="kv"><span>Today</span><span>${tokens(today.total)}</span></div>
      <div class="kv"><span>Last 7 days</span><span>${tokens(sum(days, 7))}</span></div>
      <div class="kv"><span>Last 30 days</span><span>${tokens(sum(days, 30))}</span></div>
      ${chart === "none" ? "" : bars(days, chart === "tall")}
      ${chart === "none" ? "" : `<div class="row sub axis"><span>${first}</span><span>Today</span></div>`}
    </section>`;
}

function threadRow(t: ThreadUsage, current: boolean): string {
  const pct = t.contextWindow && t.contextUsed != null ? Math.min(100, (t.contextUsed / t.contextWindow) * 100) : null;
  const context = pct == null ? "" : `<div class="bar thin"><b style="width:${pct}%"></b></div>`;
  const meta = [current ? "Current" : ago(t.updatedAt), pct == null ? null : `Context ${Math.round(pct)}%`].filter(Boolean).join(" · ");
  return `
    <li class="thread ${current ? "current" : ""}" data-action="thread" data-id="${esc(t.id)}" title="${esc(t.title)}${t.model ? ` · ${esc(t.model)}` : ""}">
      <div class="row"><span class="title">${esc(t.title)}</span><span>${tokens(t.tokens)}</span></div>
      ${context}
      <div class="row sub"><span>${meta}</span>${pct == null ? "" : `<span>${tokens(t.contextUsed!)} / ${tokens(t.contextWindow!)}</span>`}</div>
    </li>`;
}

function threadsSection(s: Snapshot): string {
  const rows = [
    ...(s.thread ? [threadRow(s.thread, s.threadIsCurrent)] : []),
    ...(s.recent ?? []).map((t) => threadRow(t, false)),
  ];
  if (!rows.length) return "";
  const label = s.project ? `Threads · ${esc(s.project)}` : "Threads";
  return `<section class="block"><div class="label">${label}</div><ol class="threads">${rows.join("")}</ol></section>`;
}

function topSection(s: Snapshot): string {
  if (!s.top?.length) return "";
  const rows = s.top
    .map(
      (t) => `
      <li class="kv">
        <span class="title" title="${esc(t.title)}">${esc(t.title)}</span>
        <span class="nowrap"><span class="sub">${esc(ago(t.updatedAt))}</span>&nbsp;&nbsp;${tokens(t.tokens)}</span>
      </li>`,
    )
    .join("");
  return `<section class="block"><div class="label">Heaviest threads · 7 days</div><ol class="list">${rows}</ol></section>`;
}

function statusSection(s: Snapshot): string {
  const st = s.status;
  if (!st) return "";
  const ok = st.indicator === "none" && !st.incidents.length;
  const more = st.incidents.length > 1 ? ` +${st.incidents.length - 1}` : "";
  const text = ok ? "All systems operational" : st.incidents.length ? `${st.incidents[0]}${more}` : st.description;
  return `
    <section class="block status">
      <a class="status-link" href="${esc(st.url)}" data-action="status">
        <i class="dot ${ok ? "ok" : st.indicator === "minor" ? "warn" : "danger"}"></i>
        <span class="title">${esc(text)}</span>
        <span class="sub">Status ↗</span>
      </a>
    </section>`;
}

// ---------- render ----------

function render(): void {
  const s = state;
  const view: View = s?.view ?? guessView();
  document.body.dataset.view = view;
  if (!s) {
    root.innerHTML = header(null);
  } else if (view === "inline") {
    const today = s.daily?.at(-1);
    root.innerHTML = `
      ${header(s)}
      <div class="inline-grid">${limitsSection(s)}${s.limits ? creditsSection(s.limits) : ""}</div>
      ${today ? `<div class="row sub foot"><span>Today ${tokens(today.total)} tokens</span>${s.thread ? `<span>This thread ${tokens(s.thread.tokens)}</span>` : ""}</div>` : ""}`;
  } else if (view === "dashboard") {
    root.innerHTML = `
      ${header(s)}
      <div class="columns">
        <div class="col">${limitsSection(s)}${s.limits ? creditsSection(s.limits) : ""}${threadsSection(s)}${statusSection(s)}</div>
        <div class="col">${tokensSection(s, "tall")}${topSection(s)}</div>
      </div>`;
  } else {
    root.innerHTML = `
      ${header(s)}
      ${limitsSection(s)}
      ${s.limits ? creditsSection(s.limits) : ""}
      ${threadsSection(s)}
      ${tokensSection(s)}
      ${statusSection(s)}`;
  }
}

root.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  event.preventDefault();
  if (target.dataset.action === "refresh") refresh(true);
  if (target.dataset.action === "status") app.openLink({ url: (target as HTMLAnchorElement).href }).catch(() => {});
  if (target.dataset.action === "thread" && !target.classList.contains("current")) {
    app.openLink({ url: `codex://threads/${encodeURIComponent(target.dataset.id!)}` }).catch(() => {});
  }
});

function guessView(): View {
  const name = app.getHostContext()?.toolInfo?.tool?.name;
  return name === "usage.dashboard" ? "dashboard" : name === "usage.show" ? "inline" : "panel";
}

async function refresh(force = false): Promise<void> {
  if (loading) return;
  loading = true;
  render();
  try {
    const result = await app.callServerTool({
      name: "usage.refresh",
      arguments: {
        view: state?.view ?? guessView(),
        force,
        ...(state?.threadIsCurrent && state.thread ? { threadId: state.thread.id } : {}),
      },
    });
    if (!result.isError && result.structuredContent) state = result.structuredContent as unknown as Snapshot;
  } catch {
    // Keep the last snapshot; the next tick retries.
  } finally {
    loading = false;
    render();
  }
}

function applyContext(ctx: ReturnType<App["getHostContext"]>): void {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  // Codex reports areas covered by its own chrome, e.g. the composer over sidebar apps.
  const insets = ctx?.safeAreaInsets;
  if (insets) {
    for (const side of ["top", "right", "bottom", "left"] as const) {
      document.documentElement.style.setProperty(`--safe-${side}`, `${insets[side] ?? 0}px`);
    }
  }
}

app.ontoolresult = (result) => {
  if (result.structuredContent) {
    state = result.structuredContent as unknown as Snapshot;
    render();
  }
};
app.addEventListener("hostcontextchanged", applyContext);
render();
app.connect().then(() => {
  applyContext(app.getHostContext());
  render();
});

// Inline cards stay a snapshot of when they were posted; tabs keep themselves current.
setInterval(() => {
  if (state?.view === "inline" || document.visibilityState !== "visible") return;
  refresh();
}, REFRESH_MS);
setInterval(() => {
  if (state && !loading) render();
}, TICK_MS);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state && state.view !== "inline" && Date.now() - state.generatedAt > REFRESH_MS) refresh();
});
