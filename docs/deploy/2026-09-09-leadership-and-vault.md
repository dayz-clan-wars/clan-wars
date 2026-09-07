# Leadership and the vault (increment 7) — deploy runbook

Migration 0028 adds six tables — `succession_claims`, `faction_votes`,
`faction_vote_ballots`, `vault_locks`, `vault_history`, `guest_passes` — and one nullable
column, `factions.next_vote_allowed_at`. Nothing is dropped, nothing is backfilled, and
no existing column changes shape. The bot gains the leadership tick (succession claims
and no-confidence votes past their deadline), the guild-removal handler
(`guildMemberRemove`), `/guest`, and two new reconciler steps (guest-pass voice
overwrites, `[TAG] gamertag`/bare-gamertag nicknames). The site gains `/clan/vault` and
`/clan`'s new leadership panel (open a vote, cast a ballot, claim succession) plus guest
passes on `/clan/settings`.

1. **Apply migration 0028** with the one-off runner from
   `docs/deploy/2026-09-02-dormancy.md`. It is additive — six new tables and one
   nullable column on `factions` — so there is nothing to backfill and the bot may keep
   running while it applies. Restart the bot afterward so it picks up the new code path
   (old code against the new schema is safe; it just does not use the new columns/tables
   yet).

2. **Bot permissions**: in addition to what 3b required (Manage Roles, Manage Channels,
   Manage Nicknames guild-wide, the bot's role above every clan role and above
   `@Alpha`), the bot's role now needs **Manage Roles specifically on the clan voice
   category** — granting/revoking a guest pass is a permission-overwrite edit on that
   channel (`grantVoiceAccess`/`revokeVoiceAccess` in `apps/bot/src/guild.ts`), and
   Discord refuses an overwrite edit without it even though the bot already holds
   Manage Roles guild-wide. The **Server Members Intent** (already enabled since 3b) is
   what delivers `guildMemberRemove` — no new intent to request.

3. **`/guest` registers itself on start** — it is in `buildCommands()`, put via the
   existing `Routes.applicationGuildCommands` call in `discord.ts`'s `start()`, the same
   per-guild registration every other command uses. No separate registration step.
   After restart, verify `/guest` appears when typed in a clan's own text channel (it
   refuses to run anywhere else — `handleGuestCommand` looks up the clan by
   `discordTextChannelId`).

4. ⚠️ **First structure pass after restart applies nicknames to every full member at
   once.** `structureTick`'s new step 8 diffs `desiredNicknames()` (from
   `nicknameFor` in `packages/domain/src/leadership.ts`: `[TAG] gamertag` for a full
   member of a holding clan, bare gamertag — capped at 32, same as the prefixed form —
   for every other linked user) against each member's current Discord nickname. On a
   guild with existing clans, expect `nicknamesSet N` where N is every full member at
   once — one REST call per member, one time, then zero on every following tick unless a
   gamertag or clan changes. On a large guild this is a real burst of REST calls; it is
   not a config error.

5. ⚠️ **Ruling 10, verbatim: no reconciliation of guild removals that happened while the
   bot was down.** `guildMemberRemove` is a gateway event only — `apps/bot/src/guild-removal.ts`
   handles it as it arrives (checking the event's guild id against
   `DISCORD_GUILD_ID` first; a mismatch writes nothing), and there is no catch-up sweep
   at startup. A pass over "linked users not currently in the member cache" was
   considered and rejected: it would mass-unlink everyone on a cold cache, exactly the
   failure `membersFetched` already guards against elsewhere in the reconciler. **Cost if
   this happens:** a player who left the Discord server during downtime keeps their
   roster row (and, if they were the leader, keeps `factions.leader_discord_id`) until
   an officer notices and kicks them from `/clan`. **How to spot one**: a roster row
   whose Discord id is not a current guild member — cross-reference `faction_members` (or
   `/clans/{tag}`) against the guild's member list. **The fix**: an officer kicks that
   row from `/clan` like any other departure; `kick` does not require the target to still
   be in the guild.

6. **Verification.**
   - Open a no-confidence vote in a test clan (two full members minimum — the opener's
     ballot counts on open) and watch a `vote_opened` notice post to the clan channel
     (`notice-text.ts`'s `vote_opened` renderer, with the closing time and a link to the
     site).
   - Add a vault lock, then rotate it (or rotate all locks) and confirm the clan channel
     shows "🔐 Codes rotated by `<gamertag>` — see the vault." while the DM to every
     other full member says only "**`<clan>`** rotated its codes. See the vault:
     `<link>`." — never the code itself (`codes_rotated` in `notice-text.ts`; the code
     lives only behind `revealLock`/`confirmLock`, gated by the lock's `min_role`, and
     `/api/vault/reveal` is the one POST that returns JSON instead of a redirect so the
     code never appears in a URL, per the existing web write-boundary rules).
   - Grant a guest pass with `/guest @user` in a clan channel and confirm the target
     gains View + Connect on that clan's voice channel within one tick, and loses it
     again after 24h (or immediately on `revokeGuestPass` from `/clan/settings`).

7. **Acceptance queries** (read-only, safe against `factions_live`):

       select count(*) from factions;

   Run this first for scale, same as any deploy — it costs nothing and confirms you are
   pointed at the database you think you are. Then re-run the existing dormancy
   read-only acceptance check (`docs/deploy/2026-09-02-dormancy.md`'s query, or the copy
   kept in `CLAUDE.md`'s "Current state" section) — this deploy does not touch the
   dormancy clock, but it is the standing go/no-go check before any bot restart: any
   active/dormant row already over the 7-day threshold will transition on the very next
   tick regardless of what this deploy changed.

⚠️ **A leader removed from the guild exposes every vault lock in their clan**, releases
their solo declaration on every active server, and closes any open vote or succession
claim in that clan silently — `voided`/`failed`, no cooldown, no notice, since there is
no seat left to succeed to and no leader left to depose (the same silent-close path
`disbandFactionTx` uses). This is `removeFromGuildDb`'s job
(`@factions/roster/internal`, never exported from the package root — `smoke.test.ts` and
`exports.test.ts` both pin the allowlist) and it is the one roster write a gateway event
is allowed to start.
