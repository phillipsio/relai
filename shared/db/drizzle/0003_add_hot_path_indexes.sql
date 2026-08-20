CREATE INDEX IF NOT EXISTS "events_repo_created_idx" ON "events" USING btree ("repo_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_thread_idx" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_agent_target_unique" ON "subscriptions" USING btree ("agent_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_target_idx" ON "subscriptions" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_repo_status_idx" ON "tasks" USING btree ("repo_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_assigned_idx" ON "tasks" USING btree ("assigned_to");