export interface ApiClientConfig {
    baseUrl: string;
    secret: string;
}
export declare class ApiClient {
    private baseUrl;
    private headers;
    constructor(config: ApiClientConfig);
    private request;
    getTasks(params: {
        projectId?: string;
        status?: string;
        assignedTo?: string;
    }): Promise<unknown[]>;
    getTask(id: string): Promise<unknown>;
    createTask(body: {
        projectId: string;
        createdBy: string;
        title: string;
        description: string;
        priority?: string;
        domains?: string[];
        metadata?: Record<string, unknown>;
    }): Promise<unknown>;
    updateTask(id: string, body: {
        status?: string;
        assignedTo?: string | null;
        priority?: string;
        metadata?: Record<string, unknown>;
    }): Promise<unknown>;
    sendMessage(threadId: string, body: {
        fromAgent: string;
        toAgent?: string;
        type: string;
        body: string;
        metadata?: Record<string, unknown>;
    }): Promise<unknown>;
    getMessages(threadId: string): Promise<unknown[]>;
    getUnread(agentId: string, projectId: string): Promise<unknown[]>;
    markRead(threadId: string, agentId: string): Promise<unknown>;
    registerAgent(body: {
        projectId: string;
        name: string;
        role: string;
        domains?: string[];
    }): Promise<unknown>;
    heartbeat(agentId: string): Promise<unknown>;
    listAgents(projectId: string): Promise<unknown[]>;
    createThread(body: {
        projectId: string;
        title: string;
        type?: string;
    }): Promise<unknown>;
    listThreads(projectId: string, type?: string): Promise<unknown[]>;
    concludePlan(threadId: string, summary?: string): Promise<unknown>;
}
//# sourceMappingURL=api-client.d.ts.map