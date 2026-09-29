// Thread totals from Codex's local state DB, plus context-window fill read from the
// tail of the thread's rollout file.
import { open } from "node:fs/promises";
import { join, sep } from "node:path";
import { codexHome } from "./paths.js";

export type ThreadUsage = {
  id: string;
  title: string;
  model: string | null;
  cwd: string | null;
  tokens: number;
  updatedAt: number;
  contextUsed: number | null;
  contextWindow: number | null;
};
// Threads that share a Codex project with the current one, or the latest ones overall.
export type Neighbors = { project: string | null; threads: ThreadUsage[] };

const TAIL_BYTES = 1024 * 1024;

type Row = {
  id: string;
  title: string | null;
  model: string | null;
  cwd: string | null;
  tokens_used: number | null;
  updated_at_ms: number | null;
  rollout_path: string | null;
};

// node:sqlite ships with Node 22.5+; load it lazily so older runtimes still get limits.
type Database = { prepare(sql: string): { all(...params: (string | number)[]): unknown[] }; close(): void };
let DatabaseSync: (new (path: string, options: { readOnly: boolean }) => Database) | null = null;

async function query<T = Row>(sql: string, ...params: (string | number)[]): Promise<T[]> {
  if (!DatabaseSync) {
    try {
      ({ DatabaseSync } = (await import("node:sqlite")) as any);
    } catch {
      throw new Error(`Thread stats need Node.js 22.5 or newer (running ${process.version})`);
    }
  }
  const db = new DatabaseSync!(join(codexHome(), "state_5.sqlite"), { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

const COLUMNS = `id, coalesce(nullif(name, ''), nullif(title, ''), preview, 'Untitled') as title,
  model, cwd, tokens_used, updated_at_ms, rollout_path`;
// Conversations started by the user in the app or TUI; `exec` runs are scripts and automations.
const USER_THREADS = `archived = 0 and coalesce(thread_source, '') in ('user', '') and source != 'exec'`;

function toUsage(row: Row): ThreadUsage {
  return {
    id: row.id,
    title: row.title ?? "Untitled",
    model: row.model,
    cwd: row.cwd,
    tokens: row.tokens_used ?? 0,
    updatedAt: row.updated_at_ms ?? 0,
    contextUsed: null,
    contextWindow: null,
  };
}

async function readContext(path: string): Promise<{ used: number; window: number } | null> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"type":"token_count"')) continue;
      try {
        const info = JSON.parse(lines[i])?.payload?.info;
        if (info?.last_token_usage && info.model_context_window) {
          return { used: info.last_token_usage.total_tokens, window: info.model_context_window };
        }
      } catch {}
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function withContext(row: Row): Promise<ThreadUsage> {
  const usage = toUsage(row);
  if (row.rollout_path) {
    const context = await readContext(row.rollout_path).catch(() => null);
    usage.contextUsed = context?.used ?? null;
    usage.contextWindow = context?.window ?? null;
  }
  return usage;
}

// The thread with `id`, or the most recently active user thread.
export async function currentThread(id?: string): Promise<ThreadUsage | null> {
  const rows = id
    ? await query(`select ${COLUMNS} from threads where id = ?`, id)
    : await query(`select ${COLUMNS} from threads where ${USER_THREADS} order by updated_at_ms desc limit 1`);
  return rows[0] ? withContext(rows[0]) : null;
}

const inside = (cwd: string, root: string) => cwd === root || cwd.startsWith(root.endsWith(sep) ? root : root + sep);

// Codex groups threads into projects by folder: a project owns one or more root paths.
async function projectOf(cwd: string): Promise<{ name: string; roots: string[] } | null> {
  const rows = await query<{ project_id: string; name: string; path: string }>(
    `select pr.project_id, p.name, pr.path from project_roots pr join projects p on p.id = pr.project_id`,
  );
  const match = rows.filter((r) => inside(cwd, r.path)).sort((a, b) => b.path.length - a.path.length)[0];
  if (!match) return null;
  return { name: match.name, roots: rows.filter((r) => r.project_id === match.project_id).map((r) => r.path) };
}

// Recently active threads from the current thread's project; the latest threads overall
// when there is no current thread or its project has no others.
export async function neighborThreads(limit: number, current: ThreadUsage | null): Promise<Neighbors> {
  const project = current?.cwd ? await projectOf(current.cwd) : null;
  if (!project && current?.cwd) {
    // Not in a Codex project: neighbors are threads started in the same folder.
    const rows = await query(
      `select ${COLUMNS} from threads where ${USER_THREADS} and id != ? and cwd = ? order by updated_at_ms desc limit ?`,
      current.id,
      current.cwd,
      limit,
    );
    if (rows.length) return { project: null, threads: await Promise.all(rows.map(withContext)) };
  }
  if (project) {
    const where = project.roots.map(() => `(cwd = ? or cwd like ? escape '\\')`).join(" or ");
    const params = project.roots.flatMap((root) => [root, root.replace(/[\\%_]/g, "\\$&") + sep + "%"]);
    const rows = await query(
      `select ${COLUMNS} from threads where ${USER_THREADS} and id != ? and (${where})
       order by updated_at_ms desc limit ?`,
      current!.id,
      ...params,
      limit,
    );
    if (rows.length) return { project: project.name, threads: await Promise.all(rows.map(withContext)) };
  }
  const rows = await query(
    `select ${COLUMNS} from threads where ${USER_THREADS} and id != ? order by updated_at_ms desc limit ?`,
    current?.id ?? "",
    limit,
  );
  return { project: null, threads: await Promise.all(rows.map(withContext)) };
}

export async function topThreads(sinceMs: number, limit = 8): Promise<ThreadUsage[]> {
  const rows = await query(
    `select ${COLUMNS} from threads where ${USER_THREADS} and updated_at_ms >= ? order by tokens_used desc limit ?`,
    sinceMs,
    limit,
  );
  return rows.map(toUsage);
}
