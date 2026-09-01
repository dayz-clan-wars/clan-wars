CREATE TABLE IF NOT EXISTS "supply_uploads" (
	"server_id" integer PRIMARY KEY NOT NULL,
	"content_hash" text NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "supply_uploads" ADD CONSTRAINT "supply_uploads_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
