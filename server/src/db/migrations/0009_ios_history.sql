DROP INDEX "results_passed_idx";--> statement-breakpoint
ALTER TABLE "results" ADD COLUMN "platform" text;--> statement-breakpoint
UPDATE "results" r SET "platform" = ru."platform" FROM "runs" ru WHERE ru."id" = r."run_id";--> statement-breakpoint
ALTER TABLE "results" ALTER COLUMN "platform" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "results_passed_idx" ON "results" USING btree ("platform","scenario_id","id") WHERE status = 'passed';
