CREATE TABLE IF NOT EXISTS "server_restarts" (
	"server_id" integer NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "server_restarts_server_id_scheduled_for_pk" PRIMARY KEY("server_id","scheduled_for"),
	CONSTRAINT "server_restarts_outcome_valid" CHECK ("server_restarts"."outcome" IN ('restarted','skipped','missed'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "server_restarts" ADD CONSTRAINT "server_restarts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
