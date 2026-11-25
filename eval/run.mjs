// Bundles eval/cases.ts with what it imports from src/ and runs it under Node.
// Usage: node eval/run.mjs [times each case is run, default 2]     ONLY=<case id> to run one.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// The bundler the test runner already brings (vitest → vite → esbuild); nothing is added for this.
const from = (name, base) => dirname(createRequire(join(base, "package.json")).resolve(`${name}/package.json`));
const esbuild = require(from("esbuild", from("vite", from("vitest", join(here, "..")))));
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set (it is read from the environment; see eval/README.md)");
  process.exit(2);
}
const out = join(here, "..", "node_modules", ".cache", "eval", "cases.mjs");
mkdirSync(dirname(out), { recursive: true });
await esbuild.build({
  entryPoints: [join(here, "cases.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "esm",
  alias: { "cloudflare:workers": join(here, "stub.js") },
  loader: { ".md": "text" },
  logLevel: "warning",
});
await import(pathToFileURL(out).href);
