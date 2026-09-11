// Bundles both bins so the published package has zero dependencies: npx then
// resolves nothing, and no workspace package can leak into the tarball.
import { execFileSync } from "node:child_process";
import { readdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(PKG));
const STORE = join(REPO, "node_modules/.pnpm");
const newest = readdirSync(STORE)
  .filter((d) => /^esbuild@\d/.test(d))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .pop();
if (!newest) throw new Error("no esbuild in the pnpm store");
const ESBUILD = join(STORE, newest, "node_modules/esbuild/bin/esbuild");

// ESM has no require/__dirname, and the sources use both (the version is read
// from ../package.json at runtime, which resolves inside the published package).
const BANNER = [
  "import{createRequire as __cr}from'node:module';",
  "import{fileURLToPath as __ftu}from'node:url';",
  "import{dirname as __dn}from'node:path';",
  "const require=__cr(import.meta.url);",
  "const __filename=__ftu(import.meta.url);",
  "const __dirname=__dn(__filename);",
].join("");

for (const [entry, out] of [["src/index.ts", "dist/cli.js"], ["../mcp-server/src/index.ts", "dist/mcp.js"]]) {
  execFileSync(ESBUILD, [
    entry, "--bundle", "--platform=node", "--target=node20.12", "--format=esm",
    `--outfile=${out}`, `--banner:js=${BANNER}`, "--log-level=warning",
  ], { cwd: PKG, stdio: "inherit" });
  chmodSync(join(PKG, out), 0o755);
}
console.log(`built dist/cli.js and dist/mcp.js with ${newest}`);
