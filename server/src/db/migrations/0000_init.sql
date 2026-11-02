CREATE TABLE "accounts" (
	"username" text PRIMARY KEY NOT NULL,
	"queue_id" integer
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"name" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"udid" text NOT NULL,
	"appium_url" text NOT NULL,
	"system_port" integer NOT NULL,
	"host" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "devices_udid_unique" UNIQUE("udid")
);
--> statement-breakpoint
CREATE TABLE "queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"scenario_id" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"device" text,
	"lease_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "results" (
	"id" serial PRIMARY KEY NOT NULL,
	"queue_id" integer NOT NULL,
	"run_id" integer NOT NULL,
	"scenario_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"device" text,
	"status" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"error" text,
	"screenshot" text,
	"log" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "results_queueId_unique" UNIQUE("queue_id")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"app_build" text NOT NULL,
	"commit" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_queue_id_queue_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue" ADD CONSTRAINT "queue_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue" ADD CONSTRAINT "queue_device_devices_name_fk" FOREIGN KEY ("device") REFERENCES "public"."devices"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_queue_id_queue_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_device_devices_name_fk" FOREIGN KEY ("device") REFERENCES "public"."devices"("name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "queue_pending_idx" ON "queue" USING btree ("run_id","id") WHERE status = 'pending';