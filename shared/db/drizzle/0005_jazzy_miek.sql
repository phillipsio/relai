ALTER TABLE "threads" ADD COLUMN "dm_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "threads_dm_key_unique" ON "threads" USING btree ("dm_key");