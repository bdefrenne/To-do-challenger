-- Merge decisions into notes + drop the analysis/work start timestamps.
-- Data-preserving: existing task_decisions rows are copied into task_notes as
-- type='decision' (rationale folded into the body, category kept as a tag)
-- BEFORE the table is dropped.

-- 1. Widen note_type. Recreate the enum rather than ALTER TYPE ... ADD VALUE,
--    because a value added with ADD VALUE cannot be USED in the same
--    transaction — and step 3 inserts 'decision' rows right below.
ALTER TABLE "task_notes" ALTER COLUMN "type" TYPE text USING "type"::text;--> statement-breakpoint
DROP TYPE "public"."note_type";--> statement-breakpoint
CREATE TYPE "public"."note_type" AS ENUM('decision', 'progress', 'milestone', 'blocker', 'question', 'fyi');--> statement-breakpoint
ALTER TABLE "task_notes" ALTER COLUMN "type" TYPE "public"."note_type" USING "type"::"public"."note_type";--> statement-breakpoint

-- 2. Notes gain free-form tags.
ALTER TABLE "task_notes" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint

-- 3. Copy every decision into a note (preserve id + author + timestamp).
INSERT INTO "task_notes" ("id", "task_id", "user_id", "type", "note", "tags", "author", "created_at")
SELECT
  "id",
  "task_id",
  "user_id",
  'decision',
  "decision" || COALESCE(E'\n\nWhy: ' || "rationale", ''),
  ARRAY["category"::text],
  "author",
  "created_at"
FROM "task_decisions";--> statement-breakpoint

-- 4. Drop the decisions table, the start-stamp columns, and the decision enums.
DROP TABLE "task_decisions" CASCADE;--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "analysis_started_at";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "work_started_at";--> statement-breakpoint
DROP TYPE "public"."decision_category";--> statement-breakpoint
DROP TYPE "public"."decision_outcome";--> statement-breakpoint
DROP TYPE "public"."decision_phase";
