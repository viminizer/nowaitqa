CREATE TABLE "catalogs" (
	"commit" text PRIMARY KEY NOT NULL,
	"scenarios" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
