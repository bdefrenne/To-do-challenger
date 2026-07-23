ALTER TABLE "tasks" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tasks_archived_idx" ON "tasks" USING btree ("archived_at");