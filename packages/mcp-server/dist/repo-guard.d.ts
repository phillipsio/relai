export type GuardSource = "process.cwd()" | "RELAI_REPO_PATH" | "registered repoPath";
export interface GuardCandidate {
    dir: string;
    source: GuardSource;
}
export interface GuardFailure {
    candidate: GuardCandidate;
    reason: string;
    fix: string;
}
export type GuardResult = {
    ok: true;
    via?: GuardSource;
} | {
    ok: false;
    message: string;
};
export declare function guardCandidates(fetchRepoPath: () => Promise<string | null | undefined>, env?: NodeJS.ProcessEnv): Promise<GuardCandidate[]>;
export declare function requirePositiveMatch(dir: string, repoUrl: string): {
    ok: true;
} | {
    ok: false;
    reason: string;
    fix: string;
};
export declare function assertRepoMatch(cwd: string, repoUrl: string, fetchRepoPath: () => Promise<string | null | undefined>, env?: NodeJS.ProcessEnv): Promise<GuardResult>;
export declare function guardFailureMessage(failures: GuardFailure[]): string;
//# sourceMappingURL=repo-guard.d.ts.map