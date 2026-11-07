CREATE TABLE "runner_hosts" (
	"name" text PRIMARY KEY NOT NULL,
	"session" text NOT NULL,
	"os" text NOT NULL,
	"appium_url" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inventory_at" timestamp with time zone,
	"inventory" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setup_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"session" text NOT NULL,
	"target_key" text NOT NULL,
	"target" jsonb NOT NULL,
	"boot" boolean NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"claim" text,
	"claim_until" timestamp with time zone,
	"started_at" timestamp with time zone,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"device_name" text,
	"reserved_udid" text,
	"reserved_port" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" DROP CONSTRAINT "devices_udid_unique";--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "virtual_key" text;--> statement-breakpoint
ALTER TABLE "setup_jobs" ADD CONSTRAINT "setup_jobs_host_runner_hosts_name_fk" FOREIGN KEY ("host") REFERENCES "public"."runner_hosts"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_jobs" ADD CONSTRAINT "setup_jobs_device_name_devices_name_fk" FOREIGN KEY ("device_name") REFERENCES "public"."devices"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "setup_target_open_idx" ON "setup_jobs" USING btree ("host","target_key") WHERE status IN ('queued','active','interrupted');--> statement-breakpoint
CREATE INDEX "setup_host_work_idx" ON "setup_jobs" USING btree ("host","status","id");--> statement-breakpoint
CREATE INDEX "setup_retention_idx" ON "setup_jobs" USING btree ("updated_at","id") WHERE status IN ('succeeded','failed','cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX "devices_host_udid_idx" ON "devices" USING btree ("host","udid");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_virtual_target_idx" ON "devices" USING btree ("host","virtual_key");