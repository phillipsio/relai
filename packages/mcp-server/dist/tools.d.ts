import { z } from "zod";
import type { ApiClient } from "./api-client.js";
export declare function buildTools(client: ApiClient, agentId: string, projectId: string): ({
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
})[];
//# sourceMappingURL=tools.d.ts.map