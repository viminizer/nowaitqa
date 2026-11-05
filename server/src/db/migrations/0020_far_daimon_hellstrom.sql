ALTER TABLE "runs" ADD COLUMN "release_policy" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "release_gate" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "rerun_of" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "partial_coverage" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_rerun_of_runs_id_fk" FOREIGN KEY ("rerun_of") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "queue_history_idx" ON "queue" USING btree ("scenario_id","run_id","slot","attempt");