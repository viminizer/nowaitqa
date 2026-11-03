CREATE TABLE "notifiers_on" (
	"name" text PRIMARY KEY NOT NULL,
	"since" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "runs_finished_idx" ON "runs" USING btree ("finished_at") WHERE status <> 'running';