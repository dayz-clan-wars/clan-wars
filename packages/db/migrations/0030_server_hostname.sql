ALTER TABLE "servers" ADD COLUMN "hostname" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "hostname_seen_at" timestamp with time zone;