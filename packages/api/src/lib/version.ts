import { execFileSync } from "node:child_process";

// "Is the fix deployed?" had no answer from the API, so answering it meant ssh
// onto the box. That is what let production sit two commits behind main with a
// security fix merged and believed live (task_o6BhrRbJndRhyMdvnctAy).
//
// There is no build step: the API runs TypeScript under tsx straight from a git
// checkout, and a deploy is `git pull` + restart. So the commit has to be read
// at runtime rather than injected at build time. RELAI_COMMIT wins when set,
// for any deploy that is not a working checkout. cwd is inside the repo both in
// production (WorkingDirectory=/opt/relai/app/packages/api) and in dev, and git
// walks up to find the root.
let resolved: string | null | undefined;

export function deployedCommit(): string | null {
  if (resolved !== undefined) return resolved;

  const fromEnv = process.env.RELAI_COMMIT?.trim();
  if (fromEnv) {
    resolved = fromEnv;
    return resolved;
  }

  try {
    resolved = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim() || null;
  } catch {
    // Not a checkout, no git, or a timeout. Unknown is a real answer and is
    // better than refusing to serve the probe.
    resolved = null;
  }
  return resolved;
}
