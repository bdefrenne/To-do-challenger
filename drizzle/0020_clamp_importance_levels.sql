-- Custom SQL migration file, put your code below! --
-- Data-only migration (no schema change).
--
-- The importance ladder collapsed from [-2..3] to [-1..2]. Clamp any existing
-- rows that sit outside the new range: Critical (3) -> High (2), Icebox (-2) ->
-- Low (-1). The column stays smallint NOT NULL DEFAULT 0.
UPDATE "tasks" SET "importance" = 2 WHERE "importance" > 2;
--> statement-breakpoint
UPDATE "tasks" SET "importance" = -1 WHERE "importance" < -1;
