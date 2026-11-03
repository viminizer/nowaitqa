CREATE TABLE "notifications" (
	"run_id" integer NOT NULL,
	"notifier" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_run_id_notifier_pk" PRIMARY KEY("run_id","notifier")
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;