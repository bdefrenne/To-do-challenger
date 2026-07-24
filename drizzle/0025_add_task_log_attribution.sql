CREATE TYPE "public"."log_source" AS ENUM('ui', 'api', 'mcp');--> statement-breakpoint
ALTER TABLE "task_logs" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "task_logs" ADD COLUMN "source" "log_source";--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
