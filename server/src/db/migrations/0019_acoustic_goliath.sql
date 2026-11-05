CREATE TABLE "fixture_resources" (
	"id" serial PRIMARY KEY NOT NULL,
	"queue_id" integer NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text DEFAULT 'awaiting_cleanup',
	"attempts" integer DEFAULT 0 NOT NULL,
	"claim" text,
	"claim_until" timestamp with time zone,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixture_resources_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "fixture_resources" ADD CONSTRAINT "fixture_resources_queue_id_queue_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queue"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fixture_attempt_name_idx" ON "fixture_resources" USING btree ("queue_id","name");--> statement-breakpoint
CREATE INDEX "fixture_open_idx" ON "fixture_resources" USING btree ("id") WHERE status <> 'cleaned';--> statement-breakpoint
CREATE INDEX "fixture_pending_idx" ON "fixture_resources" USING btree ("next_attempt_at","id") WHERE status <> 'cleaned';--> statement-breakpoint
CREATE INDEX "fixture_retention_idx" ON "fixture_resources" USING btree ("updated_at","id") WHERE status = 'cleaned';