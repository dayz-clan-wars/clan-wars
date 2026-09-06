# Roster package (increment 2c-a) — deploy runbook

Migration 0022 adds four columns to `factions`, three to `faction_members` (all with
defaults or nullable) and two tables. Metadata-only; the bot may keep running while it
applies. The one player-visible change ships with the bot: accepting an invite makes a
PENDING member until the log sees them at the base.

1. **Read the migration.** `packages/db/migrations/0022_roster_membership.sql`. Nothing
   applies migrations in production.
2. **Apply 0022** with the one-off runner from `docs/deploy/2026-09-02-dormancy.md`.
3. **Confirm:**

       select column_name, column_default from information_schema.columns
        where table_name = 'faction_members' and column_name = 'status';
       select count(*) from faction_members where status <> 'full';

   `'full'::text` and `0` — every existing member is exactly as they were.
4. **Deploy the bot** (`sudo systemctl restart clan-wars-bot`). Watch one tick:
   `journalctl -u clan-wars-bot -f` — no `presence tick failed` / `pending expiry failed`.
   The web image needs no rebuild for this increment (no page changed), but rebuilding it
   is harmless.
5. **Acceptance.** `/faction invite` a linked player; they `/faction invites` → accept; the
   reply says pending. `select status, pending_since from faction_members where dayz_id =
   '<uid>'` → `pending`. Have them stand at the base (or raise there); within a tick,
   `status = 'full'` and `seen_at_base_event_id` set. Then the dormancy check from
   `docs/deploy/2026-09-05-declarations.md` step 9, with `select count(*) from factions`.
6. **What did not change.** Every slash command still works (retired in 2c-b). No Discord
   role or channel is granted on promotion (increment 3). No DM says "you're full" yet
   (increment 3's notices).
