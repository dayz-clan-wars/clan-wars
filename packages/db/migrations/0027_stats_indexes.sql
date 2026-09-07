CREATE INDEX IF NOT EXISTS "events_raise_by_player_idx" ON "events" USING btree (("payload"->>'dayzId')) WHERE "events"."type" = 'flag.raised';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "identity_links_gamertag_lower_idx" ON "identity_links" USING btree (lower("gamertag"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kills_victim_dayz_idx" ON "kills" USING btree ("victim_dayz_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kills_killer_dayz_idx" ON "kills" USING btree ("killer_dayz_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "players_gamertag_lower_idx" ON "players" USING btree (lower("gamertag"));