CREATE INDEX "queue_leased_idx" ON "queue" USING btree ("device") WHERE status = 'leased';--> statement-breakpoint
CREATE INDEX "results_device_idx" ON "results" USING btree ("device","created_at");