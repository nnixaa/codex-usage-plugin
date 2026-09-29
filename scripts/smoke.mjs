// Smoke test: spawn the built server over stdio and exercise every tool.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/server.js"], cwd: "plugins/usage" }));
const info = client.getServerVersion();
console.log("server:", info.name, info.version, "icons:", info.icons?.length ?? 0);
const { tools } = await client.listTools();
for (const t of tools) console.log("tool:", t.name, JSON.stringify(t._meta ?? {}));
const uri = tools.find((t) => t.name === "usage.panel")._meta.ui.resourceUri;
const res = await client.readResource({ uri });
console.log("resource:", res.contents[0].mimeType, res.contents[0].text.length, "chars");
for (const name of ["usage.panel", "usage.show", "usage.dashboard"]) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: {} });
  console.log(`\n== ${name} (${Date.now() - t} ms)\n${r.content[0].text}`);
  const s = r.structuredContent;
  console.log("daily:", s.daily ? s.daily.length : null, "top:", s.top ? s.top.length : null, "limitsError:", s.limitsError);
}
await client.close();
