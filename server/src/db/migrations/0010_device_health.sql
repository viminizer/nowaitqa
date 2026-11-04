ALTER TABLE "devices" ADD COLUMN "paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "health_since" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "queue_slot_idx" ON "queue" USING btree ("run_id","slot","attempt");--> statement-breakpoint
CREATE INDEX "results_device_passed_idx" ON "results" USING btree ("device","created_at") WHERE status = 'passed';