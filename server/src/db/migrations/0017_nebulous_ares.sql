ALTER TABLE "devices" ADD COLUMN "platform_version" text;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "profile" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "profiles" jsonb;