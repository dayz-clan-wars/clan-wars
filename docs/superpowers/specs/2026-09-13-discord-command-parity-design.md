# Discord command parity — design

**Date:** 2026-09-13
**Status:** design, approved in chat; not yet planned or implemented

Everything a player can do on the site, they can also do in Discord with a slash
command. The site does not change and does not go away. This adds a second front
door onto the same domain layer.

---

## 1. Why this is a reversal, and what stays true

Spec §9.1 retired every slash command. `apps/bot/src/retired-commands.ts` keeps
`/link`, `/unlink`, `/whoami` and `/faction` registered as bare names that answer
"Manage this on the site: …", and `apps/bot/test/retired-commands.test.ts` pins
that behaviour. CLAUDE.md line 236 states it as an invariant. `/guest` is the one
live command.

This design un-retires that layer. Two things the retirement was protecting stay
protected, and they are the load-bearing constraints below:

- **Every reply is ephemeral.** The comment on `Reply` in
  `apps/bot/src/commands.ts` is the reason: a link challenge sequence posted
  publicly is a challenge any bystander can perform, binding their own UID to
  someone else's Discord account. The rule generalises — a public reply to any
  command leaks who is in what clan, who holds what, and what a vault contains.
  There is no `public:` option on any command.
- **No rule lives in two places.** Increment 2b moved the link flow and the solo
  base out of `apps/bot` into `packages/roster` specifically so the bot and the
  site could not disagree. A command layer that re-derives actor, clan or role is
  that mistake again. §3 is how this design avoids it.

`RETIRED_COMMANDS`, `RETIRED_DESCRIPTION`, `retiredPath`, `retiredReply` and
`apps/bot/test/retired-commands.test.ts` are deleted. The message-component
fallback in `discord.ts` (`interaction.isMessageComponent()` → retired reply) is
replaced by real component routing (§5).

## 2. What "parity" covers

Scope, as agreed: **every write, reads where a Discord embed genuinely serves.**

### 2.1 Writes — all 38, no exceptions

| Group | Site endpoint | Command |
|---|---|---|
| Link | `/api/link/start` | `/link start` |
| | `/api/link/cancel` | `/link cancel` |
| | `/api/link/unlink` | `/link unlink` |
| Base | `/api/base/declare` | `/base declare` |
| | `/api/base/release` | `/base release` |
| Roster (officer+) | `/api/clan/invite` | `/roster invite` |
| | `/api/clan/revoke-invite` | `/roster revoke` |
| | `/api/clan/decide-request` | `/roster decide` |
| | `/api/clan/kick` | `/roster kick` |
| | `/api/clan/promote` | `/roster promote` |
| | `/api/clan/demote` | `/roster demote` |
| | `/api/clan/transfer` | `/roster transfer` |
| Membership (self) | `/api/clan/leave` | `/clan leave` |
| | `/api/clans/[tag]/request` | `/clans join` |
| | `/api/me/request/withdraw` | `/me withdraw` |
| | `/api/me/invite/accept` | `/me accept` |
| | `/api/me/invite/decline` | `/me decline` |
| Settings (leader) | `/api/clan/rename` | `/clan rename` |
| | `/api/clan/recruiting` | `/clan recruiting` |
| | `/api/clan/disband` | `/clan disband` |
| | `/api/clan/rebind` | `/clan rebind` |
| Founding | `/api/claim` | `/found` |
| Leadership | `/api/clan/claim-succession` | `/lead claim` |
| | `/api/clan/open-vote` | `/lead vote` |
| | `/api/clan/cast-vote` | `/lead ballot` |
| Vault | `/api/vault/add` | `/vault add` |
| | `/api/vault/edit` | `/vault edit` |
| | `/api/vault/delete` | `/vault delete` |
| | `/api/vault/reveal` | `/vault reveal` |
| | `/api/vault/confirm` | `/vault confirm` |
| | `/api/vault/rotate` | `/vault rotate` |
| Guest | `/api/clan/guest` | `/guest grant` (exists) |
| | `/api/clan/revoke-guest` | `/guest revoke` |
| Map | `/api/map/pin` | `/map pin` |
| | `/api/map/pin/delete` | `/map unpin` |

`/api/link/status`, `/api/link/search`, `/api/players/suggest` and
`/api/map/state` are reads that back UI, not player actions; they become
autocomplete sources and `/link status` / `/map pins` (§2.2).

### 2.2 Reads

Embed-rendered in Discord:

| Site page | Command | Embed |
|---|---|---|
| `/me` | `/me` | Link state, clan and role, open invites, open requests, what is waiting on you (`attention`) |
| `/link` | `/link status` | Current link, open challenge and its emote sequence, how the last one ended |
| `/base` | `/base show` | Your raises and your declaration |
| `/clan` | `/clan info` | Roster with roles and last-seen, invites out, requests in, open vote or succession claim |
| `/clans` | `/clans list` | Directory, recruiting first |
| `/clans/{tag}` | `/clans show tag:` | One clan's public page, flag as thumbnail |
| `/scoreboard` | `/scoreboard` | The open season's table |
| `/alphas` | `/alphas` | Closed weeks of the open season |
| `/seasons` | `/seasons` | Closed seasons and champions |
| `/war-log` | `/warlog` | Recent raids and defenses, newest first |
| `/players/{gamertag}` | `/player gamertag:` | One player's profile |
| `/players/boards/{board}` | `/board kind: scope: page:` | One board, one page |
| `/clan/board` | `/board … mine:true` | The same, narrowed to your clan |
| `/clan/vault` | `/vault list` | Locks your rank may see; never a code |
| achievement wall | `/achievements` | Badge wall for a player or clan |

Site-only, by design — the command replies with a one-line pointer and a link:

- **`/map` the visual map.** `/map pins` lists your clan's pins as text with ids,
  and `/map pin` / `/map unpin` write them. But the map itself — your fix,
  clanmates, intruders, public bases, watch zones over a 12 800 m Livonia
  raster — is a picture. `/map` replies with the link.
- **Deep board pagination beyond a few pages.** `/board` serves
  `BOARD_PAGE_SIZE` rows per page and links to the site for browsing.

These two are the whole of the parity gap, and both are "the site draws a
picture", not "the site can do a thing Discord cannot".

## 3. Architecture — one domain layer, two front doors

### 3.1 Parameterizing `@factions/roster`

Today `packages/roster/src/index.ts` is ~60 thin wrappers of the shape:

```ts
export function invite(actorDiscordId: string, invitee: InviteeRef) {
  return inviteDb(db(), new Date(), actorDiscordId, invitee);
}
```

where `db()` is the module-level singleton in `client.ts` that reads
`DATABASE_URL`. The bot cannot use these — it owns its own `Database` handle —
so `guest-command.ts` reaches into `@factions/roster/internal` and re-derives the
clan itself. Doing that 38 more times is the duplication §1 forbids.

**Change:** extract the wrapper bodies into a factory.

```ts
// packages/roster/src/api.ts
export function makeRoster(getDb: () => Database) {
  return {
    invite: (actorDiscordId: string, invitee: InviteeRef) =>
      inviteDb(getDb(), new Date(), actorDiscordId, invitee),
    // … every other wrapper, unchanged in body
  };
}
export type Roster = ReturnType<typeof makeRoster>;
```

```ts
// packages/roster/src/index.ts
export const { invite, kick, promote, /* … */ } = makeRoster(db);
```

The site imports exactly what it imports today; `packages/roster/test/exports.test.ts`
and `apps/web/test/smoke.test.ts` still pin the same names and still pass
unchanged. The named-destructure form, rather than `export const roster = …`,
is what keeps those two tests meaningful — the export list is still a list of
names.

The bot builds its own: `const roster = makeRoster(() => db)` over the handle
`start()` already has. One pool per process, and every rule — actor resolution,
role derivation under the clan's row lock, cooldowns, caps, feed and notice rows
in the transition's own transaction — runs identically on both surfaces because
it is literally the same call.

`guest-command.ts` is deleted; `/guest grant` becomes `roster.grantGuestPass`,
which resolves the actor's clan itself. This removes the command's current
"run this in your clan's channel" requirement — a real improvement, since the
public wrapper derives the clan from the actor, not the channel.

`@factions/roster`'s header comment says the export list "IS the permission
list" for the site. That stays true and now covers both surfaces; the comment is
updated to say so.

### 3.2 Sharing the copy

`apps/web/lib/*-copy.ts` (653 lines across nine files) map outcome unions to
player-facing text as `Record<Outcome, string>`. The exhaustive record is the
point: a new outcome in `packages/roster` fails to compile until someone writes
its wording. The bot needs that same guarantee, or a rare outcome answers a
player with nothing.

**Change:** a new `packages/copy` holding, per outcome union, one record per
surface:

```ts
export const INVITE: Record<InviteOutcome, { site: string; discord: string }> = {
  ok: {
    site: "Invited. They have been told, and the invite lasts " + days(PENDING_EXPIRY_MS) + ".",
    discord: "Invited — they have been told. The invite lasts " + days(PENDING_EXPIRY_MS) + ".",
  },
  // …
};
```

Wording may differ per surface (Discord is terser, and says "on the site" where
the site says "here"), but coverage cannot: one record, both fields required.
`apps/web/lib/*-copy.ts` become one-line re-exports that project `.site`, so no
page changes.

Nine unions move: clan, vault, leadership, base, link, map, feed, scoring, stats,
achievements. `apps/web/test/copy-vocabulary.test.ts` bans the substring
"faction" in web source including identifiers — `packages/copy` is not web
source, but its strings reach players on both surfaces, so it is added to
`apps/bot/test/vocabulary.test.ts`'s `PLAYER_FACING` list instead, which checks
string literals only. Every string in `packages/copy` says "clan".

### 3.3 Where the command code lives

```
apps/bot/src/commands/
  index.ts        buildCommands() — the full registration payload
  route.ts        interactionCreate → handler, one place
  link.ts  base.ts  roster.ts  clan.ts  found.ts  lead.ts
  vault.ts  guest.ts  map.ts  clans.ts  stats.ts  scoring.ts  me.ts
  embeds/         one builder per read embed
  autocomplete.ts every autocomplete source
```

Each handler is a pure function of `(roster, interaction-shaped input, now)` →
`Reply | Modal | Components`, so it is unit-testable without a discord.js client
— the shape `handleGuestCommand` already has. `route.ts` is the only file that
touches `interaction.*`.

`apps/bot/src/discord.ts` grows one import and loses the retired-command
fallback. `guild.ts` stays the only file that calls role/channel/member APIs.

## 4. Command surface

Fourteen top-level commands, well inside Discord's 100-per-guild and
25-subcommands-per-command limits.

```
/link      start | status | cancel | unlink
/base      declare | release | show
/me        (default: your page) | accept | decline | withdraw
/clan      info | leave | rename | recruiting | rebind | disband
/roster    invite | revoke | decide | kick | promote | demote | transfer
/found
/lead      claim | vote | ballot
/vault     list | add | edit | delete | reveal | confirm | rotate
/guest     grant | revoke
/map       pins | pin | unpin
/clans     list | show | join
/player    gamertag:
/board     kind: scope: page: mine:
/scoreboard  ·  /warlog  ·  /seasons  ·  /alphas  ·  /achievements
```

`/scoreboard`, `/warlog`, `/seasons`, `/alphas`, `/achievements` are flat, no
subcommands. Naming reuses `/link` and `/clan` — currently registered as retired
stubs, so a stale client picks up the real command on the next registration.

### 4.1 Modals

Three actions take multi-field or secret input and open a modal rather than
carry it as visible slash options:

- **`/found`** — a modal for name and tag, after a select menu of free flags
  (`claimContext().freeFlags`, thumbnails via `flagImageResolver`, which the bot
  already has) and a multi-select of ceremony participants to keep. Four fields
  and two lists is not a command line.
- **`/vault add`** — name, note, minimum role, and **the code**. A slash option
  is visible while typed and persists in Discord's client-side command history;
  a modal field is neither. Non-negotiable, per §1.
- **`/vault rotate`** — when rotating one lock to a chosen code rather than a
  generated one, same reason.

`/vault reveal` answers in an ephemeral reply, which is what the site's
reveal-button does behind its own gate.

### 4.2 Autocomplete

Every id a player would otherwise have to copy off the site comes from
autocomplete over live rows, scoped to the actor:

| Option | Source |
|---|---|
| `/link start character:` | `searchGamertags` (already exists) |
| `/roster invite gamertag:` | `suggestGamertags(q, "linked")` |
| `/player gamertag:` | `suggestGamertags(q, "seen")` |
| `/roster kick\|promote\|demote\|transfer member:` | Discord user option, resolved against the roster |
| `/roster revoke invite:` | `clanFor().invitesOut` |
| `/roster decide request:` | `clanFor().requestsIn` |
| `/me accept\|decline invite:` | `myInvites` |
| `/me withdraw request:` | `myRequests` |
| `/vault * lock:` | `vaultFor().locks`, filtered to the actor's rank |
| `/guest revoke pass:` | `clanFor().guestPasses` |
| `/clan rebind pole:` | `clanFor()` rebind candidates |
| `/clans show\|join tag:` | `directory()` |
| `/map unpin pin:` | `mapState().pins` |
| `/base declare pole:` | `baseFor()` raises |

`discord.ts`'s current `interaction.isAutocomplete()` handler — which answers
every autocomplete with `[]` — is replaced by `autocomplete.ts`.

### 4.3 Confirmation

The site gates `disband`, `transfer`, `claim-succession` and `open-vote` behind a
confirm checkbox. In Discord these reply with an ephemeral button whose
`customId` carries the action and the actor id; the handler re-checks the actor
matches `interaction.user.id` before writing. A button is not a permission — the
roster call re-derives eligibility regardless, as it does for the site.

### 4.4 Coordinates

`/map pin` takes `x:` and `z:` in metres (0–12 800, Livonia), matching
`dropPin`'s contract, plus `icon:` (autocompleted from `PIN_ICONS`) and an
optional `note:` (`PIN_NOTE_MAX`). `off-map` and `bad-icon` outcomes already
exist on `DropPinOutcome` and get Discord copy like every other outcome.

## 5. Interaction routing

`route.ts` handles four interaction kinds:

1. `isChatInputCommand()` → `commandName` + `getSubcommand(false)` → handler.
2. `isAutocomplete()` → `autocomplete.ts`.
3. `isModalSubmit()` → the modal's originating handler, keyed by `customId`.
4. `isMessageComponent()` → select menus (flag pool, participants) and confirm
   buttons, keyed by `customId`.

Every path replies with `MessageFlags.Ephemeral`. The existing catch that logs
and drops one interaction stays — discord.js does not await the listener, and an
uncaught throw is an unhandled rejection that takes the bot down.

An unknown `commandName` or `customId` answers "That command is no longer
available — check the site." rather than throwing, so a stale client after a
future rename gets a sentence and not Discord's "unknown command".

## 6. What does not change

- **The site.** No page, route or component changes. `apps/web/lib/*-copy.ts`
  become re-exports; that is the only diff in `apps/web`.
- **Feed, notices and war log.** A write from Discord appends the same feed and
  notice rows in the same transaction, and `feed-tick`, `notice-tick`,
  `war-log-tick` and `structure-tick` post them exactly as they do for a write
  from the site. No new posting path.
- **`structure-tick.ts`** remains the only writer of `factions.discord_*_id` and
  the only reconciler of roles and channels. Commands never touch guild state
  directly; they write rows and let the reconciler follow.
- **Authentication.** `interaction.user.id` is the same Discord snowflake as the
  site session's `sub`. There is no new credential, no service token, no
  impersonation path. Guild membership — which the site checks as
  `session.guild` — is implicit: a guild command can only be run from inside the
  guild.
- **`factions_live`.** No migration. This design adds no column and no table.

## 7. Testing

The gate stays `npx turbo run typecheck test --concurrency=1 --force`. Expected
task count rises from 26 to 28 (`packages/copy` adds `typecheck` and `test`).

New tests:

- **`packages/roster/test/api.test.ts`** — `makeRoster` over an injected handle
  produces the same outcomes as the singleton wrappers, for one write in each
  group. Guards the §3.1 refactor.
- **`packages/roster/test/exports.test.ts`** — unchanged, still passing, is the
  proof the site's permission list did not move.
- **`packages/copy/test/coverage.test.ts`** — every outcome union has a record
  entry with both `site` and `discord` non-empty. The compiler catches a missing
  key; this catches an empty string.
- **`apps/bot/test/commands-*.test.ts`** — one per handler group, over a seeded
  database, asserting the outcome→reply mapping for every branch. The pattern is
  `guest-command.test.ts`, which already does exactly this.
- **`apps/bot/test/command-registration.test.ts`** — `buildCommands()` produces
  valid JSON, no duplicate names, within Discord's limits, and every registered
  subcommand has a handler in `route.ts` (and vice versa). This is the test that
  makes "parity" checkable rather than asserted.
- **`apps/bot/test/parity.test.ts`** — a list of the 38 write actions of §2.1,
  each naming its `@factions/roster` export and its command path. Fails when a
  new export lands in `packages/roster` with no command. This is the standing
  guard that parity does not rot on the next increment.
- **`apps/bot/test/ephemeral.test.ts`** — every reply builder in
  `apps/bot/src/commands/` sets `MessageFlags.Ephemeral`. §1 as a test.
- **`apps/bot/test/vocabulary.test.ts`** — extended to cover
  `apps/bot/src/commands/**` and `packages/copy/src/**`.

Deleted: `apps/bot/test/retired-commands.test.ts`.

## 8. Deployment

One runbook, `docs/deploy/2026-09-13-discord-commands.md`. No migration, so the
order is only: stop the bot, deploy, start the bot. Registration is
`Routes.applicationGuildCommands` at boot, as today — it replaces the whole
command list in one PUT, so the retired stubs disappear the moment the new bot
starts. Rolling back is redeploying the previous image; the same PUT restores
the old list.

The web deploy is independent and can go before or after — `apps/web` changes
only its copy imports.

Acceptance, per the project's convention, in
`docs/acceptance/2026-09-13-discord-commands.md`: one run of each of the 38
writes against `factions_live` is not appropriate on a live server; the
acceptance is instead the parity test passing, the registration test passing,
and a manual pass of `/link`, `/found`, `/roster invite`, `/vault reveal` and
`/map pin` on the staging guild.

## 9. Risks

- **The `index.ts` refactor is the one place this can break the site.** It is
  mechanical, but it is ~60 functions. `exports.test.ts` and `smoke.test.ts`
  both pin the export list by name, and the plan should sequence this refactor
  first, alone, and prove the gate green before any command is written.
- **Copy drift.** Two strings per outcome is two things to keep true. The
  mitigation is that they cannot diverge in *coverage*, only in wording, and the
  wording is meant to differ.
- **Discord's 100-command guild limit.** Fourteen top-level commands leaves
  ample room, but a future increment adding a command group should check
  `command-registration.test.ts` rather than assume.
- **Autocomplete latency.** Discord gives 3 seconds. Every autocomplete source
  above is a single indexed query the site already runs per page load; none
  needs a new index. Worth measuring `suggestGamertags` under load during
  acceptance.

## 10. Out of scope

- The visual map, and board browsing past the first pages (§2.2).
- Any change to what a player is allowed to do. This design adds a surface, not
  a capability. Every eligibility rule stays in `packages/roster` and is
  unmodified.
- DM-based commands. Guild commands only, so `interaction.guildId` is always
  present and guild membership is implicit.
