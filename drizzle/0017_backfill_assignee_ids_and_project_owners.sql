-- Custom SQL migration file, put your code below! --
-- Data-only migration (no schema change).
--
-- 1. Assignees are now stored as account ids (users.id), not display-name
--    strings. Rewrite every task's `assignees` array in place: map each
--    existing display name -> the matching user's id (case-insensitive),
--    preserving order and dropping any name that matches no account.
UPDATE "tasks" t
SET "assignees" = COALESCE(
  (
    SELECT array_agg(u."id" ORDER BY a.ord)
    FROM unnest(t."assignees") WITH ORDINALITY AS a(name, ord)
    JOIN "users" u ON lower(u."name") = lower(a.name)
  ),
  '{}'::text[]
)
WHERE array_length(t."assignees", 1) IS NOT NULL;
--> statement-breakpoint

-- 2. Every project's owner must be a member (new tasks auto-assign to a member,
--    and the members list should always include the owner). Backfill owner rows
--    for projects that predate the project_members feature.
INSERT INTO "project_members" ("project_id", "user_id")
SELECT p."id", p."user_id" FROM "projects" p
ON CONFLICT DO NOTHING;
