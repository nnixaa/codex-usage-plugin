// Builds the installable plugin: node scripts/build.mjs [--out <dir>] (default: plugins/usage)
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = resolve(outIndex >= 0 ? args[outIndex + 1] : "plugins/usage");
const { version } = JSON.parse(await readFile("package.json", "utf8"));

const manifest = {
  name: "usage",
  version,
  description: "See Codex rate limits, reset times, and token usage without leaving the conversation.",
  author: { name: "Dmitry Nehaychik", url: "https://github.com/nnixaa" },
  homepage: "https://github.com/nnixaa/codex-usage-plugin",
  license: "MIT",
  mcpServers: "./.mcp.json",
  interface: {
    displayName: "Usage",
    shortDescription: "Codex limits and token usage at a glance",
    longDescription:
      "Shows your Codex rate-limit windows with reset countdowns and pace, limit-reset credits, token usage from local session logs, the threads in the current project with their context fill, and OpenAI status. Open it beside any thread or from the sidebar.",
    developerName: "Dmitry Nehaychik",
    websiteUrl: "https://github.com/nnixaa/codex-usage-plugin",
    category: "Developer Tools",
    capabilities: ["Interactive", "Read"],
    composerIcon: "./assets/icon.svg",
    logo: "./assets/icon.svg",
    defaultPrompt: ["@Usage how much of my limit is left?"],
  },
};

const mcp = {
  mcpServers: {
    usage: {
      command: "node",
      args: ["./dist/server.js"],
      cwd: ".",
    },
  },
};

const app = await build({
  entryPoints: ["src/app/index.ts"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  logLevel: "warning",
});
const template = await readFile("src/app/index.html", "utf8");
const html = template
  .replace("<!-- APP_SCRIPT -->", () => `<script>${app.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script>`);

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "dist"), { recursive: true });
await mkdir(join(out, ".codex-plugin"), { recursive: true });

await build({
  entryPoints: ["src/server/index.ts"],
  bundle: true,
  outfile: join(out, "dist/server.js"),
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "warning",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  define: { __VERSION__: JSON.stringify(version) },
});
await writeFile(join(out, "dist/app.html"), html);
await cp("assets", join(out, "assets"), { recursive: true });
await writeFile(join(out, ".codex-plugin/plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(join(out, ".mcp.json"), JSON.stringify(mcp, null, 2) + "\n");
console.log(`Built ${out} (v${version})`);
