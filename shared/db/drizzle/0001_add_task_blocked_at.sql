ALTER TABLE "tasks" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
-- Backfill: rows already `blocked` when this landed have no stamp, and the
-- watcher fails closed without one, which would strand them. updated_at is the
-- best available proxy for when they were blocked.
UPDATE "tasks" SET "blocked_at" = "updated_at" WHERE "status" = 'blocked' AND "blocked_at" IS NULL;
