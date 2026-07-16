CREATE TYPE "public"."decision_category" AS ENUM('business', 'product', 'ux', 'technical', 'scope');--> statement-breakpoint
CREATE TYPE "public"."decision_outcome" AS ENUM('good', 'mixed', 'bad');--> statement-breakpoint
CREATE TYPE "public"."decision_phase" AS ENUM('analysis', 'execution');--> statement-breakpoint
CREATE TYPE "public"."note_type" AS ENUM('progress', 'blocker', 'question', 'fyi');--> statement-breakpoint
CREATE TABLE "task_commits" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	"sha" text NOT NULL,
	"subject" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_decisions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	"category" "decision_category" NOT NULL,
	"decision" text NOT NULL,
	"rationale" text,
	"phase" "decision_phase" DEFAULT 'analysis' NOT NULL,
	"author" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" "decision_outcome",
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"superseded_by_id" text
);
--> statement-breakpoint
CREATE TABLE "task_notes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" "note_type",
	"note" text NOT NULL,
	"author" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "next_seq" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "next_seq" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "seq" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ref" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ref_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "analysis_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "analyzed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "work_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "analysis_summary" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "plan" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "next_seq" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "task_commits" ADD CONSTRAINT "task_commits_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_commits" ADD CONSTRAINT "task_commits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_decisions" ADD CONSTRAINT "task_decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_decisions" ADD CONSTRAINT "task_decisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_commits_task_idx" ON "task_commits" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_commits_task_sha_idx" ON "task_commits" USING btree ("task_id","sha");--> statement-breakpoint
CREATE INDEX "task_decisions_task_idx" ON "task_decisions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_decisions_user_idx" ON "task_decisions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "task_notes_task_idx" ON "task_notes" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "task_notes_user_idx" ON "task_notes" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("project_id");