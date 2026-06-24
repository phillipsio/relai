export interface ApiClientConfig {
    baseUrl: string;
    secret: string;
    ownerId?: string;
}
export declare class ApiClient {
    private baseUrl;
    private headers;
    constructor(config: ApiClientConfig);
    private request;
    getRepo(id: string): Promise<{
        id: string;
        repoUrl?: string | null;
    }>;
    getTasks(params: {
        repoId?: string;
        status?: string;
        assignedTo?: string;
    }): Promise<unknown[]>;
    getTask(id: string): Promise<unknown>;
    createTask(body: {
        repoId: string;
        createdBy: string;
        title: string;
        description: string;
        priority?: string;
        assignedTo?: string;
        domains?: string[];
        specialization?: string;
        metadata?: Record<string, unknown>;
        verifyKind?: string;
        verifyReviewerId?: string;
        verifyThreadId?: string;
        verifyPath?: string;
        verifyCommand?: string;
        verifyCwd?: string;
        verifyTimeoutMs?: number;
    }): Promise<unknown>;
    updateTask(id: string, body: {
        status?: string;
        assignedTo?: string | null;
        priority?: string;
        metadata?: Record<string, unknown>;
    }): Promise<unknown>;
    submitReview(taskId: string, body: {
        decision: "approve" | "reject";
        note?: string;
    }): Promise<unknown>;
    commitTask(taskId: string, body: {
        decision?: "commit" | "reject";
        assignedTo?: string;
        note?: string;
        title?: string;
        description?: string;
        priority?: string;
        domains?: string[];
        specialization?: string;
        verifyKind?: string;
        verifyReviewerId?: string;
        verifyThreadId?: string;
        verifyPath?: string;
        verifyCommand?: string;
        verifyCwd?: string;
        verifyTimeoutMs?: number;
    }): Promise<unknown>;
    sendMessage(threadId: string, body: {
        fromAgent: string;
        toAgent?: string;
        type: string;
        body: string;
        metadata?: Record<string, unknown>;
    }): Promise<unknown>;
    getMessages(threadId: string): Promise<unknown[]>;
    getUnread(agentId: string, repoId: string): Promise<unknown[]>;
    markRead(threadId: string, agentId: string): Promise<unknown>;
    registerAgent(body: {
        repoId: string;
        name: string;
        role: string;
        domains?: string[];
    }): Promise<unknown>;
    heartbeat(agentId: string): Promise<unknown>;
    listAgents(repoId: string): Promise<unknown[]>;
    createThread(body: {
        repoId: string;
        title: string;
        type?: string;
    }): Promise<unknown>;
    listThreads(repoId: string, type?: string): Promise<unknown[]>;
    concludePlan(threadId: string, summary?: string): Promise<unknown>;
    getSessionStart(repoId?: string): Promise<Record<string, unknown>>;
}
//# sourceMappingURL=api-client.d.ts.map