import { pgTable, text, timestamp, jsonb, pgEnum, primaryKey, integer, boolean } from "drizzle-orm/pg-core";

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
  // Used when a task is created without an explicit assignee. Values:
  //   - agent ID (e.g. "agent_xyz") — auto-assign to that agent
  //   - "@auto"                     — defer to the routing scheduler
  //   - null                        — leave the task unassigned
  defaultAssignee: text("default_assignee"),
  // Free-form prose every agent reads on session start. Env quirks, current
  // focus, dev setup commands — the "everyone knows this" blob.
  context:     text("context"),
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

// ── Agent tokens ──────────────────────────────────────────────────────────────

export const tokens = pgTable("tokens", {
  id:         text("id").primaryKey(),
  agentId:    text("agent_id").references(() => agents.id, { onDelete: "cascade" }).notNull(),
  tokenHash:  text("token_hash").notNull().unique(),
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt:  timestamp("revoked_at", { withTimezone: true }),
});

// ── Project invites ───────────────────────────────────────────────────────────

export const invites = pgTable("invites", {
  id:                     text("id").primaryKey(),
  projectId:              text("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  codeHash:               text("code_hash").notNull().unique(),
  createdBy:              text("created_by").references(() => agents.id),
  suggestedName:          text("suggested_name"),
  suggestedSpecialization: text("suggested_specialization"),
  expiresAt:              timestamp("expires_at",  { withTimezone: true }).notNull(),
  acceptedAt:             timestamp("accepted_at", { withTimezone: true }),
  acceptedAgentId:        text("accepted_agent_id").references(() => agents.id),
  revokedAt:              timestamp("revoked_at",  { withTimezone: true }),
  createdAt:              timestamp("created_at",  { withTimezone: true }).defaultNow().notNull(),
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
  autoAssign:     boolean("auto_assign").notNull().default(false),
  createdBy:      text("created_by").notNull(),
  metadata:    jsonb("metadata").default({}).notNull(),
  // Set by the scheduler when a task has been `in_progress` longer than the
  // stall threshold without any update. Cleared on any subsequent PUT /tasks/:id.
  stalledAt:   timestamp("stalled_at", { withTimezone: true }),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Subscriptions ─────────────────────────────────────────────────────────────

export const subscriptionTargetTypeEnum = pgEnum("subscription_target_type", ["thread", "task", "agent"]);

export const subscriptions = pgTable("subscriptions", {
  id:         text("id").primaryKey(),
  agentId:    text("agent_id").references(() => agents.id, { onDelete: "cascade" }).notNull(),
  targetType: subscriptionTargetTypeEnum("target_type").notNull(),
  targetId:   text("target_id").notNull(),
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Notification channels ─────────────────────────────────────────────────────

export const notificationChannelKindEnum = pgEnum("notification_channel_kind", ["webhook"]);

export const notificationChannels = pgTable("notification_channels", {
  id:              text("id").primaryKey(),
  agentId:         text("agent_id").references(() => agents.id, { onDelete: "cascade" }).notNull(),
  kind:            notificationChannelKindEnum("kind").notNull(),
  // Shape depends on kind. For "webhook": { url: string, headers?: Record<string, string> }
  config:          jsonb("config").notNull(),
  // Cumulative metrics + last error, used by the circuit breaker.
  failureCount:    integer("failure_count").notNull().default(0),
  lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
  lastErrorAt:     timestamp("last_error_at",     { withTimezone: true }),
  lastError:       text("last_error"),
  // Set when the breaker trips. The channel stops receiving events until cleared.
  disabledAt:      timestamp("disabled_at",       { withTimezone: true }),
  createdAt:       timestamp("created_at",        { withTimezone: true }).defaultNow().notNull(),
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
