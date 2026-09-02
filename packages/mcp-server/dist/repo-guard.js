"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.guardCandidates = guardCandidates;
exports.requirePositiveMatch = requirePositiveMatch;
exports.assertRepoMatch = assertRepoMatch;
exports.guardFailureMessage = guardFailureMessage;
const git_1 = require("@getrelai/git");
// Fallback candidates only — cwd is handled by the caller, before these are
// ever considered.
async function guardCandidates(fetchRepoPath, env = process.env) {
    const override = env.RELAI_REPO_PATH?.trim();
    if (override)
        return [{ dir: override, source: "RELAI_REPO_PATH" }];
    try {
        const registered = (await fetchRepoPath())?.trim();
        if (registered)
            return [{ dir: registered, source: "registered repoPath" }];
    }
    catch {
        // Unreachable API must not turn a soft check into a startup crash.
    }
    return [];
}
// Stricter than checkRepoMatch: a fallback candidate must have an actual
// origin that matches, since "couldn't tell" is only a safe pass for cwd.
function requirePositiveMatch(dir, repoUrl) {
    const root = (0, git_1.getGitRoot)(dir);
    if (!root) {
        return { ok: false, reason: `Not a git repo: ${dir}.`, fix: `git clone ${repoUrl} && cd ${(0, git_1.repoNameFromUrl)(repoUrl)}` };
    }
    const origin = (0, git_1.getOriginUrl)(root);
    if (!origin) {
        return {
            ok: false,
            reason: `${root} has no origin remote to verify against ${repoUrl}.`,
            fix: `cd into a clone of ${repoUrl}, or set RELAI_SKIP_REPO_CHECK=1 to override.`,
        };
    }
    if ((0, git_1.normalizeRepoUrl)(origin) !== (0, git_1.normalizeRepoUrl)(repoUrl)) {
        return {
            ok: false,
            reason: `Working tree ${root} has origin ${origin}, but this agent's repo is ${repoUrl}.`,
            fix: `cd into a clone of ${repoUrl} (or set RELAI_SKIP_REPO_CHECK=1 to override).`,
        };
    }
    return { ok: true };
}
// The full guard, cwd-first. Pure and injectable so it's testable without
// touching process.exit or module-level state — index.ts is a thin wrapper.
async function assertRepoMatch(cwd, repoUrl, fetchRepoPath, env = process.env) {
    const cwdRoot = (0, git_1.getGitRoot)(cwd);
    if (cwdRoot) {
        // cwd's verdict is final — never rescued by another candidate.
        const check = (0, git_1.checkRepoMatch)(cwd, repoUrl);
        if (check.ok)
            return { ok: true };
        return { ok: false, message: `[relai-mcp] ${check.reason}\n  ${check.fix}` };
    }
    // cwd is inconclusive (not a git repo at all) — the actual Cursor case.
    const candidates = await guardCandidates(fetchRepoPath, env);
    const failures = [
        { candidate: { dir: cwd, source: "process.cwd()" }, reason: `Not a git repo: ${cwd}.`, fix: `git clone ${repoUrl} && cd ${(0, git_1.repoNameFromUrl)(repoUrl)}` },
    ];
    for (const candidate of candidates) {
        const check = requirePositiveMatch(candidate.dir, repoUrl);
        if (check.ok)
            return { ok: true, via: candidate.source };
        failures.push({ candidate, reason: check.reason, fix: check.fix });
    }
    return { ok: false, message: guardFailureMessage(failures) };
}
// Shows every place tried and why; names the override only when the path
// was ambient (unset) rather than a deliberate, already-wrong choice.
function guardFailureMessage(failures) {
    const lines = ["[relai-mcp] could not find a working tree for this agent's repo:"];
    for (const { candidate, reason } of failures) {
        lines.push(`  ${candidate.dir}  (from ${candidate.source})`, `    ${reason}`);
    }
    if (!failures.some((f) => f.candidate.source === "RELAI_REPO_PATH")) {
        lines.push("  If this client cannot choose a working directory (Cursor cannot), set", "  RELAI_REPO_PATH to your clone, or register the agent's repoPath.");
    }
    lines.push(`  ${failures[failures.length - 1].fix}`);
    return lines.join("\n");
}
//# sourceMappingURL=repo-guard.js.map