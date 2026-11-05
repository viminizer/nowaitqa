ALTER TABLE "queue" ADD COLUMN "progress" jsonb;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "diagnostics" text;