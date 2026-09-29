// Writes real tool results to preview/snapshots.json for the preview host.
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "snapshot", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/server.js"], cwd: "plugins/usage" }));
const out = {};
// Optional thread id makes the panel render as if opened inside that thread.
const threadId = process.argv[2];
for (const [view, tool] of [["panel", "usage.panel"], ["dashboard", "usage.dashboard"], ["inline", "usage.show"]]) {
  out[view] = await client.callTool({ name: tool, arguments: {}, ...(threadId && view === "panel" ? { _meta: { threadId } } : {}) });
}
await writeFile("preview/snapshots.json", JSON.stringify(out));
await client.close();
console.log("wrote preview/snapshots.json");
