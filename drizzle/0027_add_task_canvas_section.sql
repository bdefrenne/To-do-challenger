ALTER TABLE "tasks" ADD COLUMN "canvas_section_id" text;--> statement-breakpoint
UPDATE "tasks" SET "canvas_section_id" = "custom_fields"->>'sectionId' WHERE "custom_fields"->>'sectionId' IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_canvas_section_idx" ON "tasks" USING btree ("canvas_section_id");
