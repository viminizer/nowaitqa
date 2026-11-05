ALTER TABLE "queue" ADD COLUMN "scenario_attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "infrastructure_recoveries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "scenario_started" boolean;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "phase" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "failure_kind" text DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "scenario_started" boolean;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "recovery_action" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "recovery_note" text;--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "retry_queue_id" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "max_attempts" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "max_infrastructure_recoveries" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "max_run_infrastructure_recoveries" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "infrastructure_recoveries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_retry_queue_id_queue_id_fk" FOREIGN KEY ("retry_queue_id") REFERENCES "public"."queue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Historical ordinal was also the test-attempt counter. Preserve legacy flaky/retry behavior.
UPDATE "queue" SET "scenario_attempt" = "attempt";--> statement-breakpoint
UPDATE "results" SET "failure_kind" = NULL WHERE "status" = 'passed';
