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
export interface Notice {
    text: string;
    ids: string[];
}
export declare function diffAttention(prev: Map<string, AttentionState> | null, tasks: WatchTask[]): {
    notices: Notice[];
    next: Map<string, AttentionState>;
};
export declare function deliverAttention(prev: Map<string, AttentionState> | null, tasks: WatchTask[], send: (text: string) => Promise<unknown>): Promise<Map<string, AttentionState> | null>;
//# sourceMappingURL=owner-watch.d.ts.map