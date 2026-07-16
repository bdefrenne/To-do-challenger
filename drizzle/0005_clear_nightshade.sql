CREATE TYPE "public"."google_scope" AS ENUM('shared', 'personal');--> statement-breakpoint
CREATE TABLE "google_connections" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "google_scope" NOT NULL,
	"user_id" text NOT NULL,
	"google_email" text NOT NULL,
	"calendar_id" text DEFAULT 'primary' NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"access_token" text,
	"access_token_expiry" timestamp with time zone,
	"color" text DEFAULT '#7b68ee' NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "google_conn_shared_idx" ON "google_connections" USING btree ("scope") WHERE "google_connections"."scope" = 'shared';--> statement-breakpoint
CREATE UNIQUE INDEX "google_conn_personal_user_idx" ON "google_connections" USING btree ("user_id") WHERE "google_connections"."scope" = 'personal';--> statement-breakpoint
CREATE INDEX "google_conn_user_idx" ON "google_connections" USING btree ("user_id");