-- TD2-209: the notes feature is discontinued.
--
-- `task_notes` backed BOTH task notes (decision / progress / milestone /
-- blocker / question / fyi / review) and canvas sticky notes (the same row with
-- a `canvas_id` + x/y). All of it is gone: the /notes page, the three MCP note
-- tools, the note flags in board_review and the notes section of the standup.
-- Nothing reads the table any more, so it and its enum drop together.
DROP TABLE IF EXISTS "task_notes";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."note_type";
