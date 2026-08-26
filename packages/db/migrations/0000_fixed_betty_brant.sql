CREATE TABLE IF NOT EXISTS "adm_files" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"filename" text NOT NULL,
	"boot_at" timestamp with time zone NOT NULL,
	"lines_ingested" integer DEFAULT 0 NOT NULL,
	"complete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consumer_cursors" (
	"consumer_name" text PRIMARY KEY NOT NULL,
	"last_event_id" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"adm_file_id" bigint NOT NULL,
	"line_index" integer NOT NULL,
	"sub_index" integer DEFAULT 0 NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"raw_line_id" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "flag_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" bigint NOT NULL,
	"server_id" integer NOT NULL,
	"map" text NOT NULL,
	"pole_key" text NOT NULL,
	"dayz_id" text NOT NULL,
	"gamertag" text NOT NULL,
	"action" text NOT NULL,
	"texture" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "poles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"map" text NOT NULL,
	"pole_key" text NOT NULL,
	"x" numeric(10, 2) NOT NULL,
	"y" numeric(10, 2) NOT NULL,
	"z" numeric(10, 2) NOT NULL,
	"current_texture" text,
	"flag_raised" boolean DEFAULT false NOT NULL,
	"folded_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_lines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"adm_file_id" bigint NOT NULL,
	"line_index" integer NOT NULL,
	"content" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "servers" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "servers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"map" text NOT NULL,
	"clock_offset_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "adm_files" ADD CONSTRAINT "adm_files_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "events" ADD CONSTRAINT "events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "events" ADD CONSTRAINT "events_adm_file_id_adm_files_id_fk" FOREIGN KEY ("adm_file_id") REFERENCES "public"."adm_files"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "events" ADD CONSTRAINT "events_raw_line_id_raw_lines_id_fk" FOREIGN KEY ("raw_line_id") REFERENCES "public"."raw_lines"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flag_changes" ADD CONSTRAINT "flag_changes_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "flag_changes" ADD CONSTRAINT "flag_changes_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "poles" ADD CONSTRAINT "poles_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_lines" ADD CONSTRAINT "raw_lines_adm_file_id_adm_files_id_fk" FOREIGN KEY ("adm_file_id") REFERENCES "public"."adm_files"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "adm_files_server_filename_uniq" ON "adm_files" USING btree ("server_id","filename");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "events_idempotency_uniq" ON "events" USING btree ("server_id","adm_file_id","line_index","sub_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_type_idx" ON "events" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_server_occurred_idx" ON "events" USING btree ("server_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "flag_changes_event_uniq" ON "flag_changes" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flag_changes_pole_idx" ON "flag_changes" USING btree ("server_id","map","pole_key","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "flag_changes_actor_idx" ON "flag_changes" USING btree ("dayz_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "poles_tenant_key_uniq" ON "poles" USING btree ("server_id","map","pole_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "raw_lines_file_line_uniq" ON "raw_lines" USING btree ("adm_file_id","line_index");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "servers_name_map_uniq" ON "servers" USING btree ("name","map");