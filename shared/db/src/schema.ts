import { pgTable, text, timestamp, jsonb, pgEnum, primaryKey, integer } from "drizzle-orm/pg-core";

export const agentRoleEnum = pgEnum("agent_role", ["orchestrator", "worker"]);

export const taskStatusEnum = pgEnum("task_status", [
  "pending", "assigned", "in_progress", "completed", "blocked", "cancelled",
]);

export const taskPriorityEnum = pgEnum("task_priority", ["low", "normal", "high", "urgent"]);

export const messageTypeEnum = pgEnum("message_type", [
  "status", "handoff", "finding", "decision", "question", "escalation", "reply",
]);

export const routingMethodEnum = pgEnum("routing_method", ["rules", "claude"]);

// ── Projects ────────────────────────────────────────────────────────────────

export const projects = pgTable("projects", {
  id:          text("id").primaryKey(),
  name:        text("name").notNull(),
  repoUrl:     text("repo_url"),
  description: text("description"),
  routingMode: text("routing_mode"),  // "automated" | "manual" | null (unset)
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Agents ───────────────────────────────────────────────────────────────────

export const agents = pgTable("agents", {
  id:             text("id").primaryKey(),
  projectId:      text("project_id").references(() => projects.id).notNull(),
  name:           text("name").notNull(),
  role:           agentRoleEnum("role").notNull(),
  specialization: text("specialization"),   // e.g. "architect", "writer", "reviewer" — user-defined, nullable
  tier:           integer("tier"),           // 1 = junior (Copilot), 2 = senior (Claude); null = untiered
  domains:        text("domains").array().notNull().default([]),
  workerType:     text("worker_type"),  // "claude" | "copilot" | "human" | null (lead/orchestrator)
  repoPath:       text("repo_path"),
  connectedAt:    timestamp("connected_at", { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt:     timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Threads ───────────────────────────────────────────────────────────────────

export const threads = pgTable("threads", {
  id:        text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id).notNull(),
  title:     text("title").notNull(),
  type:      text("type"),      // null = operational thread, "plan" = collaborative planning
  status:    text("status").notNull().default("open"),  // "open" | "concluded"
  summary:   text("summary"),  // conclusion written when status → "concluded"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Messages ──────────────────────────────────────────────────────────────────

export const messages = pgTable("messages", {
  id:        text("id").primaryKey(),
  threadId:  text("thread_id").references(() => threads.id).notNull(),
  fromAgent: text("from_agent").notNull(),
  toAgent:   text("to_agent"),
  type:      messageTypeEnum("type").notNull(),
  body:      text("body").notNull(),
  metadata:  jsonb("metadata").default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  readBy:    text("read_by").array().notNull().default([]),
});

// ── Tasks ─────────────────────────────────────────────────────────────────────

export const tasks = pgTable("tasks", {
  id:          text("id").primaryKey(),
  projectId:   text("project_id").references(() => projects.id).notNull(),
  title:       text("title").notNull(),
  description: text("description").notNull(),
  status:      taskStatusEnum("status").notNull().default("pending"),
  priority:    taskPriorityEnum("priority").notNull().default("normal"),
  domains:        text("domains").array().notNull().default([]),
  specialization: text("specialization"),   // optional hint: "architect", "writer", etc.
  assignedTo:     text("assigned_to").references(() => agents.id),
  createdBy:      text("created_by").notNull(),
  metadata:    jsonb("metadata").default({}).notNull(),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Routing audit log ─────────────────────────────────────────────────────────

export const routingLog = pgTable("routing_log", {
  id:         text("id").primaryKey(),
  taskId:     text("task_id").references(() => tasks.id).notNull(),
  assignedTo: text("assigned_to").references(() => agents.id).notNull(),
  method:     routingMethodEnum("method").notNull(),
  rationale:  text("rationale").notNull(),
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
