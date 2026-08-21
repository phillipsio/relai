export type AttentionState = "blocked" | "pending_verification" | "proposed" | "stalled";
export interface WatchTask {
    id: string;
    title?: string;
    status?: string;
    repoId?: string;
    stalledAt?: string | null;
    metadata?: Record<string, unknown> | null;
}
export declare function attentionStateOf(task: WatchTask): AttentionState | null;
export declare function diffAttention(prev: Map<string, AttentionState> | null, tasks: WatchTask[]): {
    notices: string[];
    next: Map<string, AttentionState>;
};
//# sourceMappingURL=owner-watch.d.ts.map