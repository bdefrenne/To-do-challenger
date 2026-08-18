-- Work days (TD-65).
--
-- Two changes, one feature:
--
--   1. `task_status_events.worked_on` — the working day a transition is credited
--      to, when that differs from the day `at` falls on. `at` stays the immutable
--      record of when we learned; this is which day the work belongs to. Null
--      means "derive from `at`", which is right for almost every row, so there is
--      nothing to backfill.
--
--   2. `work_days` — one row per person per project per working day, holding the
--      two artifacts a day can produce (the morning snapshot, the standup prose).
--      Deliberately no task list: a day's membership is a query over
--      `task_status_events`, so it can never disagree with the board. And no
--      `sealed` column: a day is sealed once a later day for the same
--      (user, project) has been drafted.

ALTER TABLE "task_status_events" ADD COLUMN "worked_on" date;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "task_status_events_credited_worked_on_idx"
  ON "task_status_events" ("credited_to", "worked_on");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "work_days" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "project_id" text NOT NULL,
  "day" date NOT NULL,
  "ready_at" timestamp with time zone,
  "snapshot" jsonb,
  "drafted_at" timestamp with time zone,
  "bullets" text,
  "summary" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "work_days" ADD CONSTRAINT "work_days_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "work_days" ADD CONSTRAINT "work_days_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "work_days_user_project_day_idx"
  ON "work_days" ("user_id", "project_id", "day");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "work_days_user_day_idx"
  ON "work_days" ("user_id", "day");
