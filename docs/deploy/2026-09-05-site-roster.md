# The site as the tool (increment 2c-b) — deploy runbook

No migration. Two deployables, **together**: the web image gains `/clans`, `/clans/{tag}`,
`/clan`, `/clan/settings`, `/claim/{ceremony}` and the fuller `/me`; the bot retires every
slash command in the same step (spec §15 ⚠️: never before the pages exist, so no capability
is lost between two deploys).

Prerequisites: 2b (`docs/deploy/2026-09-05-site-link-and-base.md`, migration 0021) and 2c-a
(`docs/deploy/2026-09-05-roster-package.md`, migration 0022) applied and running.

1. **Env.** Add `SITE_BASE_URL=https://dayzclanwars.com` to the bot's `.env` (optional; that
   is the default, validated as a bare origin — no path, query string or fragment). Remove
   `BOT_RESERVATION_TTL_MS`, `BOT_INVITE_TTL_MS`, `BOT_COOLDOWN_MS`, `BOT_RENAME_COOLDOWN_MS`,
   `BOT_REBIND_COOLDOWN_MS` and `BOT_CHALLENGE_TTL_MS` if set — nothing reads them now.
2. **Build the web image first** (`docker compose build web`) so the swap is one `up`.
3. **Swap.** `docker compose up -d web && sudo systemctl restart clan-wars-bot`. The bot
   re-registers its four command names bare on start; Discord clients pick the change up
   within a minute.
4. **Confirm the bot:** `journalctl -u clan-wars-bot -f` shows the registration and the
   ticks; in Discord, `/faction` (any) and `/link` answer `Manage this on the site: …`.
5. **Confirm the site:** `/clans` anonymously (public, live); `/clans/<tag>` shows the roster
   and no coordinates; signed in, `/clan` renders your roster; `/clan/settings` refuses a
   member and admits an officer.
6. **Acceptance.** From a test account: invite by gamertag on `/clan` → the invitee sees it
   on `/me` → Accept → pending on both pages → stand at the base → full within a tick.
   Rename with a held tag → refused with the hold sentence. Then the dormancy check from
   `docs/deploy/2026-09-05-declarations.md` step 9, with `select count(*) from factions`.
7. **What did not change / what moved.** No Discord role, channel or notice on any roster
   event (increment 3). The ceremony DM now links to `/claim/{id}`; every other DM is
   unchanged. The bot no longer releases a solo base on unlink — its `/unlink` command and
   `apps/bot/src/declaration-wiring.ts` are both gone; the site's `unlink` (`@factions/roster`)
   performs that release now, so nothing is lost, it just moved sides.
