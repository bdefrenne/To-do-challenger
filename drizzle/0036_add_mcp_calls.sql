-- MCP call log (TD2-211): one row per MCP invocation, so "what has an agent
-- been doing on my board" is answerable. `task_logs` records what CHANGED on a
-- task; this records what was ASKED — including every read, which leaves no
-- other trace anywhere in the system.
CREATE TABLE IF NOT EXISTS "mcp_calls" (
  "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "user_id" text,
  "surface" "log_source" DEFAULT 'mcp' NOT NULL,
  "kind" text DEFAULT 'tool' NOT NULL,
  "name" text NOT NULL,
  "args" jsonb,
  "ok" boolean NOT NULL,
  "error" text,
  "duration_ms" integer NOT NULL,
  "result_bytes" integer
);

DO $$ BEGIN
  ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "mcp_calls_at_idx" ON "mcp_calls" ("at");
CREATE INDEX IF NOT EXISTS "mcp_calls_user_at_idx" ON "mcp_calls" ("user_id","at");
CREATE INDEX IF NOT EXISTS "mcp_calls_name_at_idx" ON "mcp_calls" ("name","at");
