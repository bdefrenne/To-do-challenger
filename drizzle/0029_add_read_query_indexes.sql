-- Indexes for the activity-window reads (TD-52).
--
-- Task reads can now filter on "what changed between X and Y" (statusSince,
-- completedAt, updatedAt) and on who touched a task (the activity log's
-- actor_id inside a window). task_logs had only a task_id index, so the actor
-- EXISTS subquery would have scanned the whole log.

CREATE INDEX IF NOT EXISTS "tasks_status_since_idx" ON "tasks" ("status_since");
CREATE INDEX IF NOT EXISTS "tasks_completed_at_idx" ON "tasks" ("completed_at");
CREATE INDEX IF NOT EXISTS "tasks_updated_at_idx" ON "tasks" ("updated_at");
CREATE INDEX IF NOT EXISTS "task_logs_actor_at_idx" ON "task_logs" ("actor_id", "at");
