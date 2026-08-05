-- Whiteboard notes (TD-55): task_notes becomes polymorphic — a note anchors
-- to a task, a canvas (a sticky dropped at x/y), or both (a sticky that also
-- references a task). Not mutually exclusive, so `task_id` only loses its
-- NOT NULL; the new anchor rule is enforced by the CHECK below instead.
--
-- `actor_id` mirrors task_logs/task_status_events' attribution FK — notes
-- previously only carried a free-text `author` display label, so "written by
-- a person" vs "written by Claude" wasn't queryable.
--
-- `updated_at` lets a note's own change (a drag, a resolve) trip the global
-- change cursor on its own, without piggybacking on bumping tasks.updated_at
-- (which canvas-anchored notes have no task to bump).

ALTER TABLE "task_notes" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_notes" ADD COLUMN "canvas_id" text;--> statement-breakpoint
ALTER TABLE "task_notes" ADD COLUMN "x" double precision;--> statement-breakpoint
ALTER TABLE "task_notes" ADD COLUMN "y" double precision;--> statement-breakpoint
ALTER TABLE "task_notes" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "task_notes" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_canvas_id_canvases_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_anchor_check" CHECK ("task_notes"."task_id" IS NOT NULL OR "task_notes"."canvas_id" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "task_notes_canvas_idx" ON "task_notes" USING btree ("canvas_id");
