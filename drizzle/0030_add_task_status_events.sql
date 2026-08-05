-- Status events (TD-54): the queryable record of WHOSE WORK a transition is.
--
-- Append-only — one row per status transition, never updated. Work stints are
-- derived from consecutive rows, so there is no span state here to leak or fall
-- out of sync with the task's real status.
--
-- Two attribution columns on purpose: `actor_id` is who performed it (who
-- clicked), `credited_to` is whose work it is (the assignee on `ui`, the actor
-- on agent surfaces; NULL when nobody can honestly be credited). Collapsing
-- those into one field is what made every earlier standup wrong.
--
-- Distinct from task_logs, which stays a human prose timeline nobody queries.

CREATE TABLE IF NOT EXISTS "task_status_events" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid(),
  "task_id" text NOT NULL REFERENCES "tasks" ("id") ON DELETE CASCADE,
  "from_status" "task_status",
  "to_status" "task_status" NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  "source" "log_source",
  "actor_id" text REFERENCES "users" ("id") ON DELETE SET NULL,
  "credited_to" text REFERENCES "users" ("id") ON DELETE SET NULL
);

-- "What did X do between two dates" — the digest's only scan.
CREATE INDEX IF NOT EXISTS "task_status_events_credited_at_idx"
  ON "task_status_events" ("credited_to", "at");
-- One task's transitions in order — derives its stints.
CREATE INDEX IF NOT EXISTS "task_status_events_task_at_idx"
  ON "task_status_events" ("task_id", "at");
-- "What reached done in this window".
CREATE INDEX IF NOT EXISTS "task_status_events_to_status_at_idx"
  ON "task_status_events" ("to_status", "at");
