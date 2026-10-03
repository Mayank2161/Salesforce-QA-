// Bundles the extension into dist/. Load dist/ in chrome://extensions via "Load unpacked".
// Usage: node build.mjs [--watch]   (static/ is copied once; rebuild after editing it)
import { context } from "esbuild";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const watch = process.argv.includes("--watch");
const outdir = "dist";

// Empty dist/ rather than deleting it: Chrome can drop an unpacked extension whose folder vanishes.
await mkdir(outdir, { recursive: true });
for (const entry of await readdir(outdir)) await rm(join(outdir, entry), { recursive: true, force: true });
await cp("static", outdir, { recursive: true });

const common = { bundle: true, target: "chrome120", outdir, logLevel: "info", sourcemap: "linked", loader: { ".svg": "text" } };
const contexts = await Promise.all([
  // MV3 service worker declared with "type": "module".
  context({ ...common, entryPoints: { background: "src/background.ts" }, format: "esm" }),
  // Content scripts and classic <script> pages cannot be ES modules.
  context({ ...common, entryPoints: { content: "src/content/index.ts", options: "src/options.ts" }, format: "iife" }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
