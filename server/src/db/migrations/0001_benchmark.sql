ALTER TABLE "queue" ADD COLUMN "slot" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "assigned_device" text;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "leased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "split" text DEFAULT 'queue' NOT NULL;--> statement-breakpoint
ALTER TABLE "queue" ADD CONSTRAINT "queue_assigned_device_devices_name_fk" FOREIGN KEY ("assigned_device") REFERENCES "public"."devices"("name") ON DELETE no action ON UPDATE no action;