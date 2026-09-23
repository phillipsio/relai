import { execFileSync } from "node:child_process";

// "Is the fix deployed?" had no answer from the API, so answering it meant ssh
// onto the box. That is what let production sit two commits behind main with a
// security fix merged and believed live (task_o6BhrRbJndRhyMdvnctAy).
//
// RESOLVED AT MODULE LOAD, which is the whole correctness argument. There is no
// build step: the API runs TypeScript under tsx from a git checkout and a deploy
// is `git pull` + restart, so HEAD on disk and the code in memory diverge the
// moment someone pulls without restarting. Reading at boot pins the answer to
// what this process actually loaded — every module here is imported eagerly, so
// boot is when the running code was fixed. Read it per request instead and a
// pull-without-restart reports the new sha while the old code serves, which is
// a false positive on the one question this exists to answer.
//
// RELAI_COMMIT wins, for any deploy that is not a working checkout.
function resolve(): string | null {
  const fromEnv = process.env.RELAI_COMMIT?.trim();
  if (fromEnv) return fromEnv;

  // A GIT_DIR inherited from the environment overrides cwd, and cwd itself may
  // sit inside some other checkout. Either way git answers confidently about
  // the wrong repository, which is worse than not answering.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const run = (args: string[]) =>
    execFileSync("git", args, {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      killSignal: "SIGKILL",
    });

  try {
    const head = run(["rev-parse", "--short", "HEAD"]).trim();
    if (!head) return null;
    // rev-parse is blind to uncommitted work, and a hand-edit or a half-applied
    // pull on the box is exactly the state worth knowing about.
    const dirty = run(["status", "--porcelain"]).trim().length > 0;
    return dirty ? `${head}-dirty` : head;
  } catch {
    return null;
  }
}

const commit = resolve();

export function deployedCommit(): string | null {
  return commit;
}
