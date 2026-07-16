CREATE TYPE "public"."recurrence" AS ENUM('none', 'daily', 'weekly', 'monthly');--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assignees" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
UPDATE "tasks" SET "assignees" = ARRAY["assignee"] WHERE "assignee" IS NOT NULL AND "assignee" <> '';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "start_date" date;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "recurrence" "recurrence" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "depends_on" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "value" smallint;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "difficulty" smallint;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "tasks" SET "completed_at" = "updated_at" WHERE "status" = 'done';--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "priority";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "assignee";--> statement-breakpoint
DROP TYPE "public"."priority";
