-- Trash (TD2-196): DELETE on a task is now a soft delete. The row keeps its id,
-- ref and subtree; `deleted_at` is what takes it off every active surface and
-- puts it in the Trash, where it can be restored one by one or purged for good.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "tasks_deleted_idx" ON "tasks" ("deleted_at");
