CREATE INDEX "results_run_idx" ON "results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_created_idx" ON "runs" USING btree ("created_at");--> statement-breakpoint
-- Rows saved before the store interface hold file paths (<ARTIFACT_DIR>/<runId>/<file>); keep the
-- key part (<runId>/<file>). Keys have one slash, so a second slash means an old path.
UPDATE "results" SET "screenshot" = substring("screenshot" from '([0-9]+/[^/]+)$') WHERE "screenshot" ~ '/.*/';--> statement-breakpoint
UPDATE "results" SET "log" = substring("log" from '([0-9]+/[^/]+)$') WHERE "log" ~ '/.*/';
