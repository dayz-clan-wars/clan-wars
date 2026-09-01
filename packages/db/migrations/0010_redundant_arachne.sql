ALTER TABLE "adm_files" ADD COLUMN "path" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "nitrado_service_id" integer;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "active" boolean DEFAULT true NOT NULL;