-- One canvas per project (TD-136).
--
-- Canvases were global: no project reference anywhere, `listCanvases()` took no
-- arguments, and the server GUESSED which canvas to file a task onto —
-- `trayCanvasId()` scanned for a starred THIS WEEK group, else counted placement
-- groups, else took the first canvas by position. That guess is right only while
-- exactly one canvas exists. With two, `resolvePlacementSection` took
-- `groups[0]` ordered by node id across EVERY canvas, so a task's placement
-- landed on whichever canvas id happened to sort first — deterministic, and
-- arbitrary with respect to which project the task belongs to.
--
-- `project_id` states what the heuristics were guessing, so they can be deleted
-- rather than made cleverer. The unique index is what makes "the project's
-- canvas" a lookup instead of a choice.
--
-- Derived tray/lane ids stay keyed on the CANVAS id (`systemLaneId`,
-- `weekLaneId`, `WEEK_GROUP_FALLBACK`), not the project id: with a 1:1 mapping
-- either works, and keeping the canvas id means no existing pin is rewritten.

ALTER TABLE "canvases" ADD COLUMN IF NOT EXISTS "project_id" text;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "canvases" ADD CONSTRAINT "canvases_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- Attribute each existing canvas to the project most of its section nodes bind
-- boards from. A canvas is where a project's boards are laid out, so its own
-- contents are the best available evidence of whose it is.
UPDATE "canvases" c SET "project_id" = (
  SELECT b."project_id"
  FROM "canvas_nodes" n
  JOIN "boards" b ON b."id" = n."data"->>'boardId'
  WHERE n."canvas_id" = c."id" AND n."kind" = 'section'
  GROUP BY b."project_id"
  ORDER BY count(*) DESC, b."project_id"
  LIMIT 1
)
WHERE c."project_id" IS NULL;--> statement-breakpoint

-- A canvas with no board-bound sections has nothing to go on: give it the first
-- project rather than leaving it un-migratable.
UPDATE "canvases" c
SET "project_id" = (SELECT p."id" FROM "projects" p ORDER BY p."position", p."id" LIMIT 1)
WHERE c."project_id" IS NULL;--> statement-breakpoint

-- Every project needs its canvas, or the NOT NULL below has nothing to point at
-- and filing into that project would have nowhere to go.
INSERT INTO "canvases" ("user_id", "name", "project_id", "position")
SELECT
  p."user_id",
  p."name",
  p."id",
  coalesce((SELECT max("position") FROM "canvases"), 0)
    + row_number() OVER (ORDER BY p."position", p."id")
FROM "projects" p
WHERE NOT EXISTS (SELECT 1 FROM "canvases" c WHERE c."project_id" = p."id");--> statement-breakpoint

-- Deliberately AFTER the backfill: a canvas with no project can no longer be
-- created, and two canvases for one project is what re-opens the guess.
ALTER TABLE "canvases" ALTER COLUMN "project_id" SET NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "canvases_project_idx" ON "canvases" ("project_id");
