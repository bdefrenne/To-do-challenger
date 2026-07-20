ALTER TYPE "public"."note_type" ADD VALUE 'review';--> statement-breakpoint
ALTER TABLE "task_notes" ADD COLUMN "resolved_at" timestamp with time zone;