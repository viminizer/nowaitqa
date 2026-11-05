ALTER TABLE "queue" ADD COLUMN "cleanup_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "queue_cleanup_idx" ON "queue" USING btree ("device") WHERE cleanup_pending;