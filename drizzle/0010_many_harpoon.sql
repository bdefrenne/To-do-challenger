ALTER TABLE "boards" ADD COLUMN "color" text DEFAULT '#7b68ee' NOT NULL;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "git_folder" text;