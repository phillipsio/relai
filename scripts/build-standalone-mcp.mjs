#!/usr/bin/env node
// Build the standalone MCP bundle handed to someone who has no clone of this repo:
// one CommonJS file plus a README they can paste into their client.
//
// This exists because the first such bundle was built ad hoc and the recipe was
// never written down. It went stale within the hour — three MCP commits landed
// after it, including the one that made notifications work at all — and nothing
// recorded which commit it came from, so staleness was invisible until someone
// compared timestamps by hand. The manifest below fixes that: the bundle now
// states its own commit and build time.
//
//   node scripts/build-standalone-mcp.mjs [--out <dir>]
//
// Requires a clean-enough tree that `git rev-parse HEAD` means something. Warns
// (does not fail) when the working tree is dirty, since the whole point is to know
// what a recipient is actually running.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = join(REPO, "packages/mcp-server");
const ESBUILD = join(REPO, "node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild");

const outArg = process.argv.indexOf("--out");
const OUT = outArg !== -1 ? resolve(process.argv[outArg + 1]) : join(process.env.HOME, "Desktop");
const STAGE = join(OUT, "relai-mcp");
const ZIP = join(OUT, "relai-mcp.zip");

const git = (args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();

const commit = git(["rev-parse", "--short", "HEAD"]);
const dirty = git(["status", "--porcelain"]).length > 0;
const version = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).version;

if (dirty) {
  console.warn("WARNING: working tree is dirty. The bundle will not match commit " + commit + " exactly.");
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, "bin"), { recursive: true });

execFileSync(ESBUILD, [
  join(PKG, "src/index.ts"),
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node18",
  `--outfile=${join(STAGE, "bin/server.cjs")}`,
  // The recipient runs whatever Node they have; keep the bundle self-contained
  // rather than assuming an install step they were told they would not need.
  "--log-level=warning",
], { stdio: "inherit" });

cpSync(join(PKG, "standalone/README.md"), join(STAGE, "README.md"));
cpSync(join(PKG, "standalone/claude_desktop_config.example.json"), join(STAGE, "claude_desktop_config.example.json"));
cpSync(join(PKG, "standalone/mcp_json.example.json"), join(STAGE, "mcp_json.example.json"));

writeFileSync(join(STAGE, "package.json"), JSON.stringify({ name: "relai-mcp", version, private: true }, null, 2) + "\n");

// The recipient cannot run `git log`, so the bundle has to carry its own identity.
// Without this, "is their copy current?" is unanswerable from either side.
writeFileSync(join(STAGE, "BUILD.txt"),
  [
    `relai standalone MCP server`,
    `mcp-server version : ${version}`,
    `built from commit  : ${commit}${dirty ? " (working tree was dirty)" : ""}`,
    `built at           : ${new Date().toISOString()}`,
    ``,
    `If the sender's repo has moved past ${commit} and the change touched`,
    `packages/mcp-server or shared/, ask for a rebuilt zip.`,
    ``,
  ].join("\n"));

rmSync(ZIP, { force: true });
execFileSync("zip", ["-qr", ZIP, "relai-mcp"], { cwd: OUT, stdio: "inherit" });

const size = statSync(ZIP).size;
console.log(`built ${ZIP}`);
console.log(`  commit ${commit}${dirty ? " (dirty)" : ""}, mcp-server ${version}, ${(size / 1024).toFixed(0)} KiB`);
console.log(`  staged folder left at ${STAGE} for inspection`);
