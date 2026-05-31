import { z } from "zod";
import type { ApiClient } from "./api-client.js";
export declare function buildTools(client: ApiClient, agentId: string, projectId: string): ({
    name: string;
    description: string;
    inputSchema: z.ZodObject<{
        title: z.ZodString;
        description: z.ZodString;
        priority: z.ZodOptional<z.ZodEnum<["low", "normal", "high", "urgent"]>>;
        assignedTo: z.ZodOptional<z.ZodString>;
        domains: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        specialization: z.ZodOptional<z.ZodString>;
        verifyKind: z.ZodOptional<z.ZodEnum<["shell", "file_exists", "thread_concluded", "reviewer_agent"]>>;
        verifyReviewerId: z.ZodOptional<z.ZodString>;
        verifyThreadId: z.ZodOptional<z.ZodString>;
        verifyPath: z.ZodOptional<z.ZodString>;
        verifyCommand: z.ZodOptional<z.ZodString>;
        verifyCwd: z.ZodOptional<z.ZodString>;
        verifyTimeoutMs: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        title: string;
        description: string;
        assignedTo?: string | undefined;
        priority?: "low" | "normal" | "high" | "urgent" | undefined;
        domains?: string[] | undefined;
        specialization?: string | undefined;
        verifyKind?: "shell" | "file_exists" | "thread_concluded" | "reviewer_agent" | undefined;
        verifyReviewerId?: string | undefined;
        verifyThreadId?: string | undefined;
        verifyPath?: string | undefined;
        verifyCommand?: string | undefined;
        verifyCwd?: string | undefined;
        verifyTimeoutMs?: number | undefined;
    }, {
        title: string;
        description: string;
        assignedTo?: string | undefined;
        priority?: "low" | "normal" | "high" | "urgent" | undefined;
        domains?: string[] | undefined;
        specialization?: string | undefined;
        verifyKind?: "shell" | "file_exists" | "thread_concluded" | "reviewer_agent" | undefined;
        verifyReviewerId?: string | undefined;
        verifyThreadId?: string | undefined;
        verifyPath?: string | undefined;
        verifyCommand?: string | undefined;
        verifyCwd?: string | undefined;
        verifyTimeoutMs?: number | undefined;
    }>;
    handler: (input: {
        title: string;
        description: string;
        priority?: string;
        assignedTo?: string;
        domains?: string[];
        specialization?: string;
        verifyKind?: string;
        verifyReviewerId?: string;
        verifyThreadId?: string;
        verifyPath?: string;
        verifyCommand?: string;
        verifyCwd?: string;
        verifyTimeoutMs?: number;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
} | {
    name: string;
    description: string;
    inputSchema: z.ZodObject<{
        status: z.ZodDefault<z.ZodEnum<["assigned", "in_progress", "pending", "all"]>>;
    }, "strip", z.ZodTypeAny, {
        status: "assigned" | "in_progress" | "pending" | "all";
    }, {
        status?: "assigned" | "in_progress" | "pending" | "all" | undefined;
    }>;
    handler: (input: {
        status?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
} | {
    name: string;
    description: string;
    inputSchema: z.ZodObject<{
        taskId: z.ZodString;
        status: z.ZodEnum<["in_progress", "completed", "blocked", "cancelled"]>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        status: "in_progress" | "completed" | "blocked" | "cancelled";
        taskId: string;
        metadata?: Record<string, unknown> | undefined;
    }, {
        status: "in_progress" | "completed" | "blocked" | "cancelled";
        taskId: string;
        metadata?: Record<string, unknown> | undefined;
    }>;
    handler: (input: {
        taskId: string;
        status: string;
        metadata?: Record<string, unknown>;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
} | {
    name: string;
    description: string;
    inputSchema: z.ZodObject<{
        threadId: z.ZodString;
        type: z.ZodEnum<["status", "handoff", "finding", "decision", "question", "escalation", "reply"]>;
        body: z.ZodString;
        toAgent: z.ZodOptional<z.ZodString>;
        metadata: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        type: "status" | "handoff" | "finding" | "decision" | "question" | "escalation" | "reply";
        threadId: string;
        body: string;
        metadata?: Record<string, unknown> | undefined;
        toAgent?: string | undefined;
    }, {
        type: "status" | "handoff" | "finding" | "decision" | "question" | "escalation" | "reply";
        threadId: string;
        body: string;
        metadata?: Record<string, unknown> | undefined;
        toAgent?: string | undefined;
    }>;
    handler: (input: {
        threadId: string;
        type: string;
        body: string;
        toAgent?: string;
        metadata?: Record<string, unknown>;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
} | {
    name: string;
    description: string;
    inputSchema: z.ZodObject<{}, "strip", z.ZodTypeAny, {}, {}>;
    handler: () => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
} | {
    name: string;
    description: string;
    inputSchema: z.ZodObject<{
        threadId: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        threadId: string;
    }, {
        threadId: string;
    }>;
    handler: (input: {
        threadId: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
} | {
    name: string;
    description: string;
    inputSchema: z.ZodObject<{
        type: z.ZodOptional<z.ZodEnum<["plan"]>>;
    }, "strip", z.ZodTypeAny, {
        type?: "plan" | undefined;
    }, {
        type?: "plan" | undefined;
    }>;
    handler: (input: {
        type?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
} | {
    name: string;
    description: string;
    inputSchema: z.ZodObject<{
        title: z.ZodString;
        type: z.ZodOptional<z.ZodEnum<["plan"]>>;
    }, "strip", z.ZodTypeAny, {
        title: string;
        type?: "plan" | undefined;
    }, {
        title: string;
        type?: "plan" | undefined;
    }>;
    handler: (input: {
        title: string;
        type?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
} | {
    name: string;
    description: string;
    inputSchema: z.ZodObject<{
        threadId: z.ZodString;
        summary: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        threadId: string;
        summary?: string | undefined;
    }, {
        threadId: string;
        summary?: string | undefined;
    }>;
    handler: (input: {
        threadId: string;
        summary?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
} | {
    name: string;
    description: string;
    inputSchema: z.ZodObject<{
        status: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        status?: string | undefined;
    }, {
        status?: string | undefined;
    }>;
    handler: (input: {
        status?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
} | {
    name: string;
    description: string;
    inputSchema: z.ZodObject<{
        taskId: z.ZodString;
        decision: z.ZodEnum<["approve", "reject"]>;
        note: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        taskId: string;
        decision: "approve" | "reject";
        note?: string | undefined;
    }, {
        taskId: string;
        decision: "approve" | "reject";
        note?: string | undefined;
    }>;
    handler: (input: {
        taskId: string;
        decision: "approve" | "reject";
        note?: string;
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
} | {
    name: string;
    description: string;
    inputSchema: z.ZodObject<{
        taskId: z.ZodString;
        decision: z.ZodOptional<z.ZodEnum<["commit", "reject"]>>;
        assignedTo: z.ZodOptional<z.ZodString>;
        note: z.ZodOptional<z.ZodString>;
        title: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        priority: z.ZodOptional<z.ZodEnum<["low", "normal", "high", "urgent"]>>;
        domains: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        specialization: z.ZodOptional<z.ZodString>;
        verifyKind: z.ZodOptional<z.ZodEnum<["shell", "file_exists", "thread_concluded", "reviewer_agent"]>>;
        verifyReviewerId: z.ZodOptional<z.ZodString>;
        verifyThreadId: z.ZodOptional<z.ZodString>;
        verifyPath: z.ZodOptional<z.ZodString>;
        verifyCommand: z.ZodOptional<z.ZodString>;
        verifyCwd: z.ZodOptional<z.ZodString>;
        verifyTimeoutMs: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        taskId: string;
        assignedTo?: string | undefined;
        title?: string | undefined;
        description?: string | undefined;
        priority?: "low" | "normal" | "high" | "urgent" | undefined;
        domains?: string[] | undefined;
        specialization?: string | undefined;
        verifyKind?: "shell" | "file_exists" | "thread_concluded" | "reviewer_agent" | undefined;
        verifyReviewerId?: string | undefined;
        verifyThreadId?: string | undefined;
        verifyPath?: string | undefined;
        verifyCommand?: string | undefined;
        verifyCwd?: string | undefined;
        verifyTimeoutMs?: number | undefined;
        decision?: "reject" | "commit" | undefined;
        note?: string | undefined;
    }, {
        taskId: string;
        assignedTo?: string | undefined;
        title?: string | undefined;
        description?: string | undefined;
        priority?: "low" | "normal" | "high" | "urgent" | undefined;
        domains?: string[] | undefined;
        specialization?: string | undefined;
        verifyKind?: "shell" | "file_exists" | "thread_concluded" | "reviewer_agent" | undefined;
        verifyReviewerId?: string | undefined;
        verifyThreadId?: string | undefined;
        verifyPath?: string | undefined;
        verifyCommand?: string | undefined;
        verifyCwd?: string | undefined;
        verifyTimeoutMs?: number | undefined;
        decision?: "reject" | "commit" | undefined;
        note?: string | undefined;
    }>;
    handler: (input: {
        taskId: string;
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
    }) => Promise<{
        content: {
            type: "text";
            text: string;
        }[];
    }>;
})[];
//# sourceMappingURL=tools.d.ts.map