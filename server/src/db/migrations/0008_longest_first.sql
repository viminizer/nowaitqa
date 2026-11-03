ALTER TABLE "queue" ADD COLUMN "expected_ms" integer;--> statement-breakpoint
CREATE INDEX "results_passed_idx" ON "results" USING btree ("scenario_id","id") WHERE status = 'passed';