ALTER TABLE "queue" ADD COLUMN "input_runtime" jsonb;--> statement-breakpoint
ALTER TABLE "queue" ADD COLUMN "inputs_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "input_intent" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "resolved_inputs" jsonb;