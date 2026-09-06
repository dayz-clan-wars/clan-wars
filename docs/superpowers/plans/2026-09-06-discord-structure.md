# Discord Structure (increment 3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every active clan gets its role, text channel and voice channel; they vanish at disband; `@Linked` follows the link row; a site unlink clears the nickname; the channel notices that 3a has been queueing with a null target start delivering.

**Architecture:** A **reconciler**, not a queue. Spec §4.7 governs *posts*; roles, channels and nicknames are state, and §9.1 / §5.6 name reconciliation on start as their mechanism. The bot derives the desired Discord state from the database every tick — clans that should have structures, full members who should hold a clan role, link rows that should hold `@Linked` — and diffs it against the guild's cache (warm after one `members.fetch()` at start, kept warm by the gateway with the `GuildMembers` intent). Only differences become REST writes. No roster or web code changes: leave, kick, promotion, activation, disband and unlink are all already database transitions, and the reconciler reads their result. `factions.discord_*_id` (3a's columns) record the created ids, written column by column right after each create so a crash between creates resumes without duplicates. The `@Linked` role doubles as the "we set this nickname" marker: a `@Linked` holder with no `identity_links` row is exactly "unlinked since last tick", so the reconciler clears their nickname and then removes the role.

**Tech Stack:** discord.js 14 (`GatewayIntentBits.GuildMembers`, `guild.roles.create`, `guild.channels.create` with `ChannelType.GuildText` / `GuildVoice` and `permissionOverwrites`), drizzle-orm 0.36, vitest. No migration.

**Spec:** `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` — §9.1 (structure, roles, nicknames), §5.1 (created at activation, deleted at disband), §5.3 (role removed on leave/kick), §5.5 (`@Linked` on link, removed on unlink), §7 rows "activation + lapse", "presence", "nickname sync", §10.1, §14 ("Deleting a clan's channels at disband deletes its history. Say so on the disband confirmation"), §15 row 3b.

## Global Constraints

- **Exactly one bot instance** (§3). The reconciler assumes it is the only writer of `discord_*_id`.
- **Nothing here writes a queue row, a roster row, or a status.** The reconciler reads `factions`, `faction_members`, `identity_links` and writes only `factions.discord_role_id`, `discord_text_channel_id`, `discord_voice_channel_id`. Spec §10.4: the site never touches Discord; `apps/web` stays free of discord.js.
- **Discord first, then the column** for creates (a lost id means a stray object, found by name on the next tick — see Task 4's dedupe); **column last** for deletes too (a delete that throws leaves the id for retry). Every Discord call is best-effort and per-item: one failure never stops the pass, and the tick never throws (§14 `guardedRunner` skips overlapping runs silently, so a long pass must not wedge the runner).
- Structural interfaces for everything that touches discord.js (`GuildLike` precedent in `nickname.ts`): tests never need a client.
- Per-clan objects: role named the clan's **name**, text channel `clan-{tag lowercased}` under `CLAN_TEXT_CATEGORY_ID`, voice channel `{TAG uppercased}` under `CLAN_VOICE_CATEGORY_ID`, both visible only to the role (§9.1). Renames follow `factions.name`/`tag`.
- Config: `CLAN_TEXT_CATEGORY_ID`, `CLAN_VOICE_CATEGORY_ID`, `LINKED_ROLE_ID` are **required** snowflakes (§9.1 "the bot refuses to start with any missing"). `BOT_FEED_CHANNEL_ID` keeps its name (the spec's `CLAN_FEED_CHANNEL_ID` is the same variable; renaming it is churn with no benefit — ruling recorded here). `ALPHA_ROLE_ID` is increment 4's.
- Full members only hold the clan role (§5.3, §10.1: a pending member has "no channel"). `[TAG]` nickname prefixes are increment 7's; this increment keeps nickname = gamertag, and only ever **clears** one (on unlink).
- Player-facing text says "clan", never "faction" (`apps/bot/test/vocabulary.test.ts`). Bot-internal identifiers keep `factionId`.
- Full gate before every commit: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` → **26 successful, 26 total**. Never touch `factions_live`.
- Commit trailers: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Svc2Dv7g1XwWi8CSuY4h5e`.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/bot/src/config.ts` (modify) | three required snowflakes |
| `apps/bot/src/guild.ts` (create) | `GuildGateway`: the structural interface over one guild, plus `createGuildGateway(client, cfg)` — the ONLY place discord.js role/channel/member APIs are called; naming helpers |
| `apps/bot/src/structure-store.ts` (create) | `StructureStore`: what the reconciler reads and the three id columns it writes |
| `apps/bot/src/structure-tick.ts` (create) | `structureTick`: the diff-and-apply pass |
| `apps/bot/src/discord.ts` (modify) | intent, gateway, start-up fetch + first pass, per-tick call |
| `apps/bot/src/presence-tick.ts` (modify) | one stale comment |
| `apps/web/lib/clan-copy.ts`, `apps/web/app/clan/settings/page.tsx` (modify) | disband confirmation names the channel deletion |
| `apps/bot/README.md`, `docs/deploy/2026-09-06-discord-structure.md`, `CLAUDE.md`, spec §15 | operations |

---

### Task 1: Config — the three required ids

**Files:**
- Modify: `apps/bot/src/config.ts`, `apps/bot/test/config.test.ts`, `apps/bot/README.md` (env table + example `.env`)

**Interfaces:**
- Produces: `BotConfig` gains `clanTextCategoryId: string; clanVoiceCategoryId: string; linkedRoleId: string;`

- [ ] **Step 1: Failing tests** — in `config.test.ts`, extend `OK` with `CLAN_TEXT_CATEGORY_ID: "12345678901234567", CLAN_VOICE_CATEGORY_ID: "22345678901234567", LINKED_ROLE_ID: "32345678901234567"` (17 digits, no leading zero — `SNOWFLAKE_RE`), and add:

```ts
  it.each(["CLAN_TEXT_CATEGORY_ID", "CLAN_VOICE_CATEGORY_ID", "LINKED_ROLE_ID"])(
    "⚠️ refuses to start without %s (spec §9.1)", (key) => {
      expect(() => loadConfig({ ...OK, [key]: undefined })).toThrow(key);
      expect(() => loadConfig({ ...OK, [key]: "" })).toThrow(key);
    },
  );
  it("rejects a malformed clan category or role id at load, not at first use", () => {
    expect(() => loadConfig({ ...OK, LINKED_ROLE_ID: "000000000000000000" })).toThrow(/LINKED_ROLE_ID/u);
    expect(() => loadConfig({ ...OK, CLAN_TEXT_CATEGORY_ID: "abc" })).toThrow(/CLAN_TEXT_CATEGORY_ID/u);
  });
  it("reads the three ids", () => {
    expect(loadConfig(OK)).toMatchObject({
      clanTextCategoryId: "12345678901234567", clanVoiceCategoryId: "22345678901234567", linkedRoleId: "32345678901234567",
    });
  });
```

- [ ] **Step 2: Run** `cd apps/bot && npx vitest run test/config.test.ts` → the new cases fail (`clanTextCategoryId` undefined; missing-key cases do not throw).

- [ ] **Step 3: Implement** — add a `requiredSnowflake(env, key, what)` next to `optionalSnowflake`:

```ts
/** A snowflake that the bot cannot run without (spec §9.1: "refuses to start with any missing"). */
function requiredSnowflake(env: NodeJS.ProcessEnv, key: string, what: string): string {
  const raw = env[key];
  if (raw === undefined || raw === "") throw new Error(`${key} is not set. The bot cannot start without ${what}.`);
  if (!SNOWFLAKE_RE.test(raw)) {
    throw new Error(
      `${key} must be a Discord id — 17 to 20 digits — got ${JSON.stringify(raw)}. ` +
      "Copy it with Developer Mode enabled: right-click, Copy ID.",
    );
  }
  return raw;
}
```

and in `loadConfig`:

```ts
    clanTextCategoryId: requiredSnowflake(env, "CLAN_TEXT_CATEGORY_ID", "the category clan text channels are created in"),
    clanVoiceCategoryId: requiredSnowflake(env, "CLAN_VOICE_CATEGORY_ID", "the category clan voice channels are created in"),
    linkedRoleId: requiredSnowflake(env, "LINKED_ROLE_ID", "the @Linked role"),
```

with the three fields added to `BotConfig` and a docblock on each: "Created by hand once (runbook); the bot never creates categories or `@Linked`, only clan roles and channels inside them."

- [ ] **Step 4: README** — three rows in the env table (all `yes`), three lines in the example `.env` with 17-digit placeholders, and one paragraph under the permissions section: the bot needs **Manage Roles, Manage Channels, Manage Nicknames** guild-wide and the **Server Members Intent** enabled on the Developer Portal → Bot page (the gateway will refuse to connect without it once the intent is requested); its own role must sit **above** every clan role it creates (Discord places new roles at the bottom, so this holds by default) and above the members it renames.

- [ ] **Step 5: Gate and commit**

```bash
git add apps/bot/src/config.ts apps/bot/test/config.test.ts apps/bot/README.md
git commit -m "feat(bot): CLAN_TEXT_CATEGORY_ID, CLAN_VOICE_CATEGORY_ID and LINKED_ROLE_ID are required"
```

---

### Task 2: `guild.ts` — the gateway over one guild

**Files:**
- Create: `apps/bot/src/guild.ts`, `apps/bot/test/guild.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ClanNames = { name: string; tag: string };
  export function roleNameFor(n: ClanNames): string;          // n.name, clamped to 100 chars
  export function textChannelNameFor(n: ClanNames): string;   // `clan-${tag.toLowerCase()}`, [a-z0-9-] only
  export function voiceChannelNameFor(n: ClanNames): string;  // tag.toUpperCase()
  export type NicknameOutcome = "ok" | "is-owner" | "outranked" | "no-permission" | "failed";   // re-exported from nickname.ts
  /** Everything the reconciler does to Discord. Reads come from the gateway cache (free); writes are REST calls. */
  export interface GuildGateway {
    /** Populate the member cache. Returns the member count. Called once at start. */
    fetchAllMembers(): Promise<number>;
    createRole(name: string): Promise<string>;
    /** Text channel under CLAN_TEXT_CATEGORY_ID, visible only to `roleId`. */
    createTextChannel(name: string, roleId: string): Promise<string>;
    /** Voice channel under CLAN_VOICE_CATEGORY_ID, View + Connect only for `roleId`. */
    createVoiceChannel(name: string, roleId: string): Promise<string>;
    /** Resolve without throwing when the object is already gone (Discord 10011 Unknown Role / 10003 Unknown Channel). */
    deleteRole(roleId: string): Promise<void>;
    deleteChannel(channelId: string): Promise<void>;
    /** Cache lookups; null when the id is not in the cache (deleted by hand, or never existed). */
    roleName(roleId: string): string | null;
    channelName(channelId: string): string | null;
    renameRole(roleId: string, name: string): Promise<void>;
    renameChannel(channelId: string, name: string): Promise<void>;
    /** Cache: user ids holding the role. Empty set for an unknown role. */
    roleMembers(roleId: string): Set<string>;
    /** Cache: is this user in the guild right now. */
    isMember(userId: string): boolean;
    addRole(userId: string, roleId: string): Promise<void>;
    removeRole(userId: string, roleId: string): Promise<void>;
    /** `applyNickname` semantics: never throws, reports the outcome. */
    setNickname(userId: string, nickname: string | null): Promise<NicknameOutcome>;
  }
  export type GuildGatewayConfig = { guildId: string; clanTextCategoryId: string; clanVoiceCategoryId: string };
  export function createGuildGateway(client: Client, cfg: GuildGatewayConfig): GuildGateway;
  ```
- Consumes: `applyNickname`, `GuildLike` from `nickname.ts`.

- [ ] **Step 1: Failing tests** (`guild.test.ts`). Naming is pure; the adapter is tested against a hand-built fake `Client` the way `feed-wiring.test.ts` fakes `channels.fetch`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { roleNameFor, textChannelNameFor, voiceChannelNameFor, createGuildGateway } from "../src/guild.js";

describe("clan object names (spec §9.1)", () => {
  it("role is the name, text is clan-{tag} lowercased, voice is the TAG", () => {
    const n = { name: "Night Bears", tag: "Bear" };
    expect(roleNameFor(n)).toBe("Night Bears");
    expect(textChannelNameFor(n)).toBe("clan-bear");
    expect(voiceChannelNameFor(n)).toBe("BEAR");
  });
  it("text channel names survive characters Discord rejects", () => {
    expect(textChannelNameFor({ name: "x", tag: "A B/C" })).toBe("clan-a-b-c");
  });
  it("clamps a role name to 100 characters", () => {
    expect(roleNameFor({ name: "n".repeat(120), tag: "T" })).toHaveLength(100);
  });
});

function fakeClient() {
  const rolesCache = new Map<string, { id: string; name: string; members: Map<string, unknown> }>();
  const channelsCache = new Map<string, { id: string; name: string }>();
  const members = new Map<string, { id: string; manageable: boolean; roles: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }; setNickname: ReturnType<typeof vi.fn> }>();
  const guild = {
    id: "g", ownerId: "owner",
    roles: { cache: rolesCache, create: vi.fn(async ({ name }: { name: string }) => { const r = { id: `r-${name}`, name, members: new Map() }; rolesCache.set(r.id, r); return r; }), fetch: vi.fn(async (id: string) => rolesCache.get(id) ?? null) },
    channels: { cache: channelsCache, create: vi.fn(async (o: { name: string }) => { const c = { id: `c-${o.name}`, name: o.name, delete: vi.fn() }; channelsCache.set(c.id, c); return c; }), fetch: vi.fn(async (id: string) => channelsCache.get(id) ?? null) },
    members: { cache: members, fetch: vi.fn(async (id?: string) => (id ? members.get(id) : members)), me: { permissions: { has: () => true } } },
  };
  const client = { guilds: { fetch: vi.fn(async () => guild) } };
  return { client, guild, rolesCache, channelsCache, members };
}
const CFG = { guildId: "g", clanTextCategoryId: "cat-t", clanVoiceCategoryId: "cat-v" };

describe("createGuildGateway", () => {
  it("creates a text channel in the text category, hidden from @everyone and visible to the role", async () => {
    const f = fakeClient();
    const g = createGuildGateway(f.client as never, CFG);
    const id = await g.createTextChannel("clan-bear", "r-Bears");
    expect(id).toBe("c-clan-bear");
    const call = f.guild.channels.create.mock.calls[0]![0];
    expect(call).toMatchObject({ name: "clan-bear", type: ChannelType.GuildText, parent: "cat-t" });
    expect(call.permissionOverwrites).toEqual([
      { id: "g", deny: [PermissionFlagsBits.ViewChannel] },
      { id: "r-Bears", allow: [PermissionFlagsBits.ViewChannel] },
    ]);
  });
  it("creates a voice channel in the voice category with View + Connect for the role", async () => {
    const f = fakeClient();
    const g = createGuildGateway(f.client as never, CFG);
    await g.createVoiceChannel("BEAR", "r-Bears");
    const call = f.guild.channels.create.mock.calls[0]![0];
    expect(call).toMatchObject({ name: "BEAR", type: ChannelType.GuildVoice, parent: "cat-v" });
    expect(call.permissionOverwrites[1]).toEqual({ id: "r-Bears", allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
  });
  it("⚠️ deleteRole and deleteChannel tolerate an object that is already gone", async () => {
    const f = fakeClient();
    const g = createGuildGateway(f.client as never, CFG);
    await expect(g.deleteRole("never-existed")).resolves.toBeUndefined();
    await expect(g.deleteChannel("never-existed")).resolves.toBeUndefined();
  });
  it("roleMembers and isMember read the cache and never call REST", async () => {
    const f = fakeClient();
    f.rolesCache.set("r1", { id: "r1", name: "Bears", members: new Map([["u1", {}], ["u2", {}]]) });
    f.members.set("u1", { id: "u1", manageable: true, roles: { add: vi.fn(), remove: vi.fn() }, setNickname: vi.fn() });
    const g = createGuildGateway(f.client as never, CFG);
    await g.fetchAllMembers();
    expect([...g.roleMembers("r1")].sort()).toEqual(["u1", "u2"]);
    expect(g.roleMembers("nope").size).toBe(0);
    expect(g.isMember("u1")).toBe(true);
    expect(g.isMember("u9")).toBe(false);
    expect(g.roleName("r1")).toBe("Bears");
    expect(g.roleName("nope")).toBeNull();
  });
  it("setNickname reports applyNickname's outcome instead of throwing", async () => {
    const f = fakeClient();
    f.members.set("u1", { id: "u1", manageable: false, roles: { add: vi.fn(), remove: vi.fn() }, setNickname: vi.fn() });
    const g = createGuildGateway(f.client as never, CFG);
    await g.fetchAllMembers();
    expect(await g.setNickname("u1", null)).toBe("outranked");
    expect(await g.setNickname("owner", null)).toBe("is-owner");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run test/guild.test.ts` → fails: module not found.

- [ ] **Step 3: Implement** `guild.ts`. The adapter fetches the guild once (`client.guilds.fetch(guildId)`, cached in a closure after the first call). Deletes catch `DiscordAPIError` with `code` 10003 or 10011 (`import { DiscordAPIError } from "discord.js"`) and rethrow anything else. `fetchAllMembers` is `(await guild.members.fetch()).size`. `roleMembers(id)` is `new Set(guild.roles.cache.get(id)?.members.keys() ?? [])`. `setNickname` builds the same `GuildLike` `createNicknameApplier` builds (owner id, `members.fetch`, `members.me.permissions.has(PermissionFlagsBits.ManageNicknames)`) and calls `applyNickname`. Naming:

```ts
export function roleNameFor(n: ClanNames): string { return n.name.slice(0, 100); }
export function textChannelNameFor(n: ClanNames): string {
  return `clan-${n.tag.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "")}`.slice(0, 100);
}
export function voiceChannelNameFor(n: ClanNames): string { return n.tag.toUpperCase().slice(0, 100); }
```

- [ ] **Step 4: Run** → PASS. Also `npx vitest run test/vocabulary.test.ts` (no player-facing strings here, but the file list must still pass).

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/guild.ts apps/bot/test/guild.test.ts
git commit -m "feat(bot): GuildGateway — clan roles and channels, member roles and nicknames behind one structural interface"
```

---

### Task 3: `structure-store.ts` — what the reconciler reads and writes

**Files:**
- Create: `apps/bot/src/structure-store.ts`, `apps/bot/test/structure-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type StructureRow = {
    id: number; serverId: number; name: string; tag: string; status: string;
    roleId: string | null; textChannelId: string | null; voiceChannelId: string | null;
  };
  export interface StructureStore {
    /** active or dormant with at least one id null — needs creating (or finishing). */
    clansNeedingStructure(): Promise<StructureRow[]>;
    /** lapsed or disbanded with at least one id set — needs tearing down. */
    clansToTearDown(): Promise<StructureRow[]>;
    /** active or dormant with all three ids set — the steady state, for rename drift and role membership. */
    clansWithStructure(): Promise<StructureRow[]>;
    setRoleId(factionId: number, id: string | null): Promise<void>;
    setTextChannelId(factionId: number, id: string | null): Promise<void>;
    setVoiceChannelId(factionId: number, id: string | null): Promise<void>;
    /** factionId → discord ids of FULL members, for every clan with a role id. */
    fullMembersByClan(): Promise<Map<number, string[]>>;
    /** Every identity_links.discord_id. */
    linkedDiscordIds(): Promise<Set<string>>;
  }
  export class PgStructureStore implements StructureStore { constructor(db: Database) }
  ```
- Consumes: `factions`, `factionMembers`, `identityLinks` from `@factions/db`.

- [ ] **Step 1: Failing tests** — real database, `seedFaction` from `test/seed.ts` (it accepts `status`), the suite's usual truncate of `identity_links, faction_members, factions, declarations, poles, events, adm_files, servers restart identity cascade` in `beforeEach`:

```ts
  it("classifies clans by status and by which ids are set", async () => {
    const a = await seedFaction(db, { serverId, tag: "AAA", texture: "Flag_A", status: "active", createdAt: now, poleKey: "1.00:1.00:1.00" });
    const b = await seedFaction(db, { serverId, tag: "BBB", texture: "Flag_B", status: "dormant", createdAt: now, poleKey: "2.00:1.00:2.00" });
    const c = await seedFaction(db, { serverId, tag: "CCC", texture: "Flag_C", status: "disbanded", createdAt: now, poleKey: "3.00:1.00:3.00" });
    const d = await seedFaction(db, { serverId, tag: "DDD", texture: "Flag_D", status: "reserved", createdAt: now, poleKey: "4.00:1.00:4.00" });
    await store.setRoleId(b.id, "r-b"); await store.setTextChannelId(b.id, "t-b"); await store.setVoiceChannelId(b.id, "v-b");
    await store.setRoleId(c.id, "r-c");
    expect((await store.clansNeedingStructure()).map((r) => r.id)).toEqual([a.id]);      // reserved is NOT created (§5.1: at activation)
    expect((await store.clansWithStructure()).map((r) => r.id)).toEqual([b.id]);
    expect((await store.clansToTearDown()).map((r) => r.id)).toEqual([c.id]);
    expect(d.id).toBeGreaterThan(0);
  });
  it("a partially created clan (role only) is still 'needing structure'", async () => {
    const a = await seedFaction(db, { serverId, tag: "AAA", texture: "Flag_A", createdAt: now });
    await store.setRoleId(a.id, "r-a");
    const [row] = await store.clansNeedingStructure();
    expect(row).toMatchObject({ id: a.id, roleId: "r-a", textChannelId: null, voiceChannelId: null });
  });
  it("fullMembersByClan lists full members only, for clans with a role", async () => {
    const a = await seedFaction(db, { serverId, tag: "AAA", texture: "Flag_A", createdAt: now });
    await store.setRoleId(a.id, "r-a");
    await db.insert(factionMembers).values([
      { factionId: a.id, serverId, dayzId: "U1", discordId: "d1", role: "leader", joinedAt: now, status: "full" },
      { factionId: a.id, serverId, dayzId: "U2", discordId: "d2", role: "member", joinedAt: now, status: "pending" },
    ]);
    expect(await store.fullMembersByClan()).toEqual(new Map([[a.id, ["d1"]]]));
  });
  it("linkedDiscordIds is every identity_links row", async () => {
    await db.insert(identityLinks).values([
      { discordId: "d1", dayzId: "U1", gamertag: "One", verifiedAt: now },
      { discordId: "d2", dayzId: "U2", gamertag: "Two", verifiedAt: now },
    ]);
    expect(await store.linkedDiscordIds()).toEqual(new Set(["d1", "d2"]));
  });
```

(`factionMembers` rows need `dayzId` values that look like UIDs only if a check constraint says so — read `packages/db/src/schema.ts` `faction_members` before seeding; `"U1"` is fine unless a regex check exists, in which case use 40-character ids as `raid-tick.test.ts` does.)

- [ ] **Step 2: Run** → fails (module not found).

- [ ] **Step 3: Implement** with plain drizzle selects ordered by `factions.id`; `fullMembersByClan` joins `faction_members` to `factions` on `discordRoleId is not null and status = 'full'`, grouped in JS.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/structure-store.ts apps/bot/test/structure-store.test.ts
git commit -m "feat(bot): StructureStore — the clans, members and links the Discord reconciler reads"
```

---

### Task 4: `structure-tick.ts` — the reconciler

**Files:**
- Create: `apps/bot/src/structure-tick.ts`, `apps/bot/test/structure-tick.test.ts`, `apps/bot/test/fake-guild.ts`

**Interfaces:**
- Produces:
  ```ts
  export type StructureTickResult = {
    created: number; tornDown: number; renamed: number;
    roleAdds: number; roleRemoves: number; linkedAdds: number; linkedRemoves: number; nicknamesCleared: number;
    errors: number;
  };
  export type StructureTickOpts = {
    linkedRoleId: string;
    onError?: (what: string, err: unknown) => void;
    /** Users whose nickname the bot cannot change (owner, outranked, no permission): logged once per instance, never retried. Owned by the caller. */
    nicknameNoRetry?: Set<string>;
  };
  export async function structureTick(store: StructureStore, guild: GuildGateway, opts: StructureTickOpts): Promise<StructureTickResult>;
  ```
- Consumes: `StructureStore` (Task 3), `GuildGateway` + naming helpers (Task 2), `NoticeStore`/`PgNoticeStore` (3a) in the integration test only.

**The pass, in order (each item in its own try/catch; a throw increments `errors`, calls `onError`, and moves on):**

1. **Create** — for each `clansNeedingStructure()` row: if `roleId` null → `createRole(roleNameFor)` then `setRoleId`; if `textChannelId` null → `createTextChannel(textChannelNameFor, roleId)` then `setTextChannelId`; if `voiceChannelId` null → `createVoiceChannel(voiceChannelNameFor, roleId)` then `setVoiceChannelId`. Column right after each create, so a crash in between resumes at the next missing column. Count `created` once per clan that reached all three.
2. **Tear down** — for each `clansToTearDown()` row: `deleteChannel(text)` → `setTextChannelId(null)`, `deleteChannel(voice)` → `setVoiceChannelId(null)`, `deleteRole(role)` → `setRoleId(null)` (each only when set; channels before the role, so a crash mid-way never leaves a channel nobody can see). Count `tornDown` once per clan fully cleared.
3. **Rename drift** — for each `clansWithStructure()` row: compare `roleName(roleId)` / `channelName(text)` / `channelName(voice)` to the three helpers; rename any that differ and are non-null (null = deleted by hand: log via `onError("missing:<id>")` once per tick, do not recreate — a hand-deleted channel is an operator decision, and recreating would loop against it; the runbook says how to fix by nulling the column).
4. **Clan roles** — `fullMembersByClan()`; for each clan with a role: `desired = members.filter(isMember)`, `actual = roleMembers(roleId)`; `addRole` for desired − actual, `removeRole` for actual − desired.
5. **`@Linked`** — `desired = linkedDiscordIds().filter(isMember)`, `actual = roleMembers(linkedRoleId)`; for each in actual − desired: `setNickname(userId, null)` (skip when `nicknameNoRetry` has the user; on `is-owner`/`outranked`/`no-permission` add them to it and `onError` once; `ok`/`failed` → count `nicknamesCleared` on `ok`), then `removeRole` regardless of the nickname outcome (the link is gone; the role must go). For each in desired − actual: `addRole` (the nickname was set by `notifyCompleted` at link time; not repeated here).

- [ ] **Step 1: `test/fake-guild.ts`** — an in-memory `GuildGateway` the tests share:

```ts
import type { GuildGateway, NicknameOutcome } from "../src/guild.js";

export class FakeGuild implements GuildGateway {
  roles = new Map<string, { name: string; members: Set<string> }>();
  channels = new Map<string, { name: string; kind: "text" | "voice"; roleId: string }>();
  members = new Map<string, { nickname: string | null }>();
  nicknameOutcome: NicknameOutcome = "ok";
  calls: string[] = [];
  failNext = new Set<string>();   // method names that throw once
  private n = 0;
  private fail(m: string) { if (this.failNext.delete(m)) throw new Error(`${m} failed`); }
  async fetchAllMembers() { return this.members.size; }
  async createRole(name: string) { this.fail("createRole"); const id = `role-${++this.n}`; this.roles.set(id, { name, members: new Set() }); this.calls.push(`createRole ${name}`); return id; }
  async createTextChannel(name: string, roleId: string) { this.fail("createTextChannel"); const id = `text-${++this.n}`; this.channels.set(id, { name, kind: "text", roleId }); this.calls.push(`createTextChannel ${name}`); return id; }
  async createVoiceChannel(name: string, roleId: string) { this.fail("createVoiceChannel"); const id = `voice-${++this.n}`; this.channels.set(id, { name, kind: "voice", roleId }); this.calls.push(`createVoiceChannel ${name}`); return id; }
  async deleteRole(id: string) { this.fail("deleteRole"); this.roles.delete(id); this.calls.push(`deleteRole ${id}`); }
  async deleteChannel(id: string) { this.fail("deleteChannel"); this.channels.delete(id); this.calls.push(`deleteChannel ${id}`); }
  roleName(id: string) { return this.roles.get(id)?.name ?? null; }
  channelName(id: string) { return this.channels.get(id)?.name ?? null; }
  async renameRole(id: string, name: string) { this.roles.get(id)!.name = name; this.calls.push(`renameRole ${id} ${name}`); }
  async renameChannel(id: string, name: string) { this.channels.get(id)!.name = name; this.calls.push(`renameChannel ${id} ${name}`); }
  roleMembers(id: string) { return new Set(this.roles.get(id)?.members ?? []); }
  isMember(userId: string) { return this.members.has(userId); }
  async addRole(userId: string, roleId: string) { this.fail("addRole"); this.roles.get(roleId)?.members.add(userId); this.calls.push(`addRole ${userId} ${roleId}`); }
  async removeRole(userId: string, roleId: string) { this.fail("removeRole"); this.roles.get(roleId)?.members.delete(userId); this.calls.push(`removeRole ${userId} ${roleId}`); }
  async setNickname(userId: string, nickname: string | null) { this.calls.push(`setNickname ${userId} ${nickname}`); if (this.nicknameOutcome === "ok") { const m = this.members.get(userId); if (m) m.nickname = nickname; } return this.nicknameOutcome; }
}
```

- [ ] **Step 2: Failing tests** (`structure-tick.test.ts`) — real database via `PgStructureStore`, `FakeGuild` pre-seeded with a `LINKED` role (`guild.roles.set("linked", { name: "Linked", members: new Set() })`), fixture: server, `now`, clan BEAR (`name: "Night Bears", tag: "BEAR"`, active) with full leader `d1`/`U1`, full member `d2`/`U2`, pending `d3`/`U3`; guild members `d1, d2, d3, d4`; links for `d1, d2, d4`:

```ts
  it("creates role, text and voice channel for an active clan and records the ids", async () => {
    const r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect(r).toMatchObject({ created: 1, errors: 0 });
    const [row] = await store.clansWithStructure();
    expect(row).toMatchObject({ id: BEAR });
    expect(guild.roles.get(row!.roleId!)!.name).toBe("Night Bears");
    expect(guild.channels.get(row!.textChannelId!)).toMatchObject({ name: "clan-bear", kind: "text", roleId: row!.roleId });
    expect(guild.channels.get(row!.voiceChannelId!)).toMatchObject({ name: "BEAR", kind: "voice", roleId: row!.roleId });
  });
  it("⚠️ resumes a half-created clan without duplicating the role", async () => {
    guild.failNext.add("createTextChannel");
    let r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect(r).toMatchObject({ created: 0, errors: 1 });
    const [half] = await store.clansNeedingStructure();
    expect(half).toMatchObject({ roleId: expect.any(String), textChannelId: null });
    r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect(r).toMatchObject({ created: 1, errors: 0 });
    expect(guild.calls.filter((c) => c.startsWith("createRole"))).toHaveLength(1);
  });
  it("does not create structures for a reserved clan (§5.1: at activation)", async () => { /* seed status reserved; tick; clansWithStructure empty; no calls */ });
  it("tears a disbanded clan down, channels before the role, and nulls the ids", async () => {
    await structureTick(store, guild, { linkedRoleId: "linked" });
    await db.update(factions).set({ status: "disbanded" }).where(eq(factions.id, BEAR));
    const r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect(r).toMatchObject({ tornDown: 1 });
    expect(guild.roles.size).toBe(1);          // only Linked remains
    expect(guild.channels.size).toBe(0);
    const [f] = await db.select({ r: factions.discordRoleId, t: factions.discordTextChannelId, v: factions.discordVoiceChannelId }).from(factions).where(eq(factions.id, BEAR));
    expect(f).toEqual({ r: null, t: null, v: null });
    const order = guild.calls.filter((c) => c.startsWith("delete"));
    expect(order[2]).toMatch(/^deleteRole/u);
  });
  it("tolerates an object already deleted by hand during teardown", async () => { /* create; delete the text channel from guild.channels directly; disband; tick → tornDown 1, errors 0, ids null */ });
  it("renames the role and channels after a clan rename", async () => {
    await structureTick(store, guild, { linkedRoleId: "linked" });
    await db.update(factions).set({ name: "Day Bears", tag: "DAYB" }).where(eq(factions.id, BEAR));
    const r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect(r).toMatchObject({ renamed: 1 });
    const [row] = await store.clansWithStructure();
    expect(guild.roles.get(row!.roleId!)!.name).toBe("Day Bears");
    expect(guild.channels.get(row!.textChannelId!)!.name).toBe("clan-dayb");
    expect(guild.channels.get(row!.voiceChannelId!)!.name).toBe("DAYB");
  });
  it("gives the clan role to full members only, and takes it back after a leave", async () => {
    let r = await structureTick(store, guild, { linkedRoleId: "linked" });
    const [row] = await store.clansWithStructure();
    expect([...guild.roleMembers(row!.roleId!)].sort()).toEqual(["d1", "d2"]);   // d3 is pending
    expect(r.roleAdds).toBe(2);
    await db.delete(factionMembers).where(eq(factionMembers.discordId, "d2"));
    r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect(r.roleRemoves).toBe(1);
    expect([...guild.roleMembers(row!.roleId!)]).toEqual(["d1"]);
  });
  it("skips a full member who is not in the guild, without an error", async () => { /* member d9 full, not in guild.members → no addRole call, errors 0 */ });
  it("gives @Linked to every link row and, on unlink, clears the nickname THEN removes the role", async () => {
    guild.members.get("d4")!.nickname = "Four";
    let r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect([...guild.roleMembers("linked")].sort()).toEqual(["d1", "d2", "d4"]);
    expect(r.linkedAdds).toBe(3);
    await db.delete(identityLinks).where(eq(identityLinks.discordId, "d4"));      // what unlinkDb does
    r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect(r).toMatchObject({ linkedRemoves: 1, nicknamesCleared: 1 });
    expect(guild.members.get("d4")!.nickname).toBeNull();
    const i = guild.calls.indexOf("setNickname d4 null");
    expect(i).toBeGreaterThan(-1);
    expect(guild.calls[i + 1]).toBe("removeRole d4 linked");
  });
  it("⚠️ an unrenamable user is logged once, never retried, and still loses the role", async () => {
    await structureTick(store, guild, { linkedRoleId: "linked" });
    guild.nicknameOutcome = "outranked";
    const noRetry = new Set<string>();
    const onError = vi.fn();
    await db.delete(identityLinks).where(eq(identityLinks.discordId, "d4"));
    await structureTick(store, guild, { linkedRoleId: "linked", nicknameNoRetry: noRetry, onError });
    expect(noRetry.has("d4")).toBe(true);
    expect(guild.roleMembers("linked").has("d4")).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    // a second unlink of the same user (relinked in between) must not log again
    await db.insert(identityLinks).values({ discordId: "d4", dayzId: "U4", gamertag: "Four", verifiedAt: now });
    await structureTick(store, guild, { linkedRoleId: "linked", nicknameNoRetry: noRetry, onError });
    await db.delete(identityLinks).where(eq(identityLinks.discordId, "d4"));
    await structureTick(store, guild, { linkedRoleId: "linked", nicknameNoRetry: noRetry, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(guild.calls.filter((c) => c === "setNickname d4 null")).toHaveLength(1);
  });
  it("one Discord failure does not stop the rest of the pass, and the tick never throws", async () => {
    guild.failNext.add("addRole");
    const onError = vi.fn();
    const r = await structureTick(store, guild, { linkedRoleId: "linked", onError });
    expect(r.errors).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(r.created).toBe(1);                   // the create step before it ran
    expect(r.linkedAdds).toBe(3);                // the step after it ran
  });
  it("is a no-op on a second pass with nothing changed", async () => {
    await structureTick(store, guild, { linkedRoleId: "linked" });
    guild.calls.length = 0;
    const r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect(r).toEqual({ created: 0, tornDown: 0, renamed: 0, roleAdds: 0, roleRemoves: 0, linkedAdds: 0, linkedRemoves: 0, nicknamesCleared: 0, errors: 0 });
    expect(guild.calls).toEqual([]);
  });
  it("⚠️ a channel notice queued before the channel existed becomes deliverable once it does (3a's null-target rule)", async () => {
    await db.transaction((tx) => noticeClanTx(tx, { serverId, factionId: BEAR, kind: "joined", occurredAt: now, payload: { gamertag: "Two" } }));
    const notices = new PgNoticeStore(db);
    expect(await notices.readUnposted(10)).toEqual([]);
    await structureTick(store, guild, { linkedRoleId: "linked" });
    const [row] = await store.clansWithStructure();
    const [n] = await notices.readUnposted(10);
    expect(n).toMatchObject({ kind: "joined", target: "channel", discordTargetId: row!.textChannelId });
  });
```

- [ ] **Step 3: Run** → fails.

- [ ] **Step 4: Implement** `structure-tick.ts` exactly per the numbered pass above. A `step(what, fn)` helper wraps each item: `try { await fn() } catch (err) { out.errors++; opts.onError?.(what, err) }`. Nickname outcome handling:

```ts
const NO_RETRY: ReadonlySet<NicknameOutcome> = new Set(["is-owner", "outranked", "no-permission"]);
```

- [ ] **Step 5: Run** the file, then `vocabulary.test.ts` and the whole bot suite → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/structure-tick.ts apps/bot/test/structure-tick.test.ts apps/bot/test/fake-guild.ts
git commit -m "feat(bot): the Discord reconciler — clan roles and channels, @Linked, nickname clear on unlink"
```

---

### Task 5: Wiring — intent, start-up pass, per-tick pass

**Files:**
- Modify: `apps/bot/src/discord.ts` (`start()`), `apps/bot/src/presence-tick.ts:40-41` (stale comment), `apps/bot/test/discord.test.ts` (one signature test in the existing "modules load and their signatures match how startBot calls them" style)

**Interfaces:**
- Consumes: `createGuildGateway`, `PgStructureStore`, `structureTick`.

- [ ] **Step 1:** In `start()`:
  - `new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] })` with a comment: the members intent is privileged; the runbook enables it on the portal; without it `guild.members.fetch()` hangs and role diffs see an empty cache.
  - `const guildGateway = createGuildGateway(client, { guildId: cfg.guildId, clanTextCategoryId: cfg.clanTextCategoryId, clanVoiceCategoryId: cfg.clanVoiceCategoryId });`, `const structureStore = new PgStructureStore(db);`, `const nicknameNoRetry = new Set<string>();`.
  - A `runStructure = async (label: string) => { const s = await structureTick(structureStore, guildGateway, { linkedRoleId: cfg.linkedRoleId, nicknameNoRetry, onError: (what, err) => console.error(\`structure: ${what}\`, err) }); if (s.created || s.tornDown || s.renamed || s.roleAdds || s.roleRemoves || s.linkedAdds || s.linkedRemoves || s.nicknamesCleared) console.log(\`structure ${label}: …\`); }` — one line naming every non-zero count.
  - In `client.once("clientReady")`: before the interval starts, `await guildGateway.fetchAllMembers()` (log the count) then `await runStructure("on start")` — both inside try/catch (a failed fetch logs and continues; the per-tick pass retries). This is §9.1's "reconciled on start". Only then `setInterval`.
  - In the runner: after the presence tick and before the notice tick (a promotion this tick should hold its role before the `became_full` line posts; a channel created this tick should receive the notices queued for it), `try { await runStructure("tick") } catch (err) { console.error("structure tick failed", err) }` — the tick never throws, but the runner's discipline is one try/catch per step.
  - `notifyCompleted` and `handleUnlink`-era nickname code stay as they are.
- [ ] **Step 2:** `presence-tick.ts` docblock: replace "Discord role/channel grants: increment 3 (no ids exist yet)" with "Discord role: the structure reconciler (`structure-tick.ts`) gives full members the clan role on its next pass."
- [ ] **Step 3:** In `discord.test.ts`, add a test in the existing "signatures match" style: `structureTick(new PgStructureStore(db), new FakeGuild(), { linkedRoleId: "1" })` resolves to a zero result on an empty database, proving the three modules load and compose the way `start()` calls them.
- [ ] **Step 4:** Full gate → 26/26. Commit:

```bash
git add apps/bot/src/discord.ts apps/bot/src/presence-tick.ts apps/bot/test/discord.test.ts
git commit -m "feat(bot): reconcile Discord structure on start and every tick; GuildMembers intent"
```

---

### Task 6: The disband confirmation says the channels go

**Files:**
- Modify: `apps/web/lib/clan-copy.ts` (`DISBAND.ok` and a new exported `DISBAND_WARNING`), `apps/web/app/clan/settings/page.tsx:100-104`, `apps/web/test/clan-copy.test.ts` (or whichever file tests `clan-copy.ts` — grep `RESULT_COPY`).

Spec §14: "Deleting a clan's channels at disband deletes its history. Say so on the disband confirmation."

- [ ] **Step 1: Failing test**

```ts
  it("the disband confirmation says the clan's channels and their history are deleted (spec §14)", () => {
    expect(DISBAND_WARNING).toMatch(/channels? .* deleted/iu);
    expect(DISBAND_WARNING).toMatch(/history/iu);
  });
```

- [ ] **Step 2: Implement** — `export const DISBAND_WARNING = "Disbanding deletes the clan's text and voice channels and everything ever said in them. Nothing is archived.";` rendered as a `<p className="mt-2 text-sm text-ink-2">` above the checkbox in the Disband section; `DISBAND.ok` gains the sentence "The clan's channels are gone." Web vocabulary: no "faction" identifiers.
- [ ] **Step 3:** `cd apps/web && npx vitest run && npx tsc --noEmit` → green. Commit:

```bash
git add apps/web/lib/clan-copy.ts apps/web/app/clan/settings/page.tsx apps/web/test
git commit -m "feat(web): the disband confirmation says the channels and their history are deleted"
```

---

### Task 7: Runbook, CLAUDE.md, spec §15, README

**Files:**
- Create: `docs/deploy/2026-09-06-discord-structure.md`
- Modify: `CLAUDE.md`, `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` §15 (plan file name only), `apps/bot/README.md` (only if Task 1 left anything stale)

- [ ] **Step 1: Runbook**

```markdown
# Discord structure (increment 3b) — deploy runbook

No migration. The bot gains a reconciler that creates one role, one text channel and one voice
channel per active clan, deletes them at disband, gives full members the clan role and every
linked player `@Linked`, and clears the nickname of anyone who unlinks on the site. It runs once
at start and then every tick, and it only ever issues the Discord writes needed to close a
difference between the database and the guild — so a first run on a guild with N active clans
creates 3N objects and then goes quiet.

1. **Developer Portal → Bot.** Enable **Server Members Intent**. Without it the bot hangs on its
   first member fetch and every role diff sees an empty guild.
2. **Guild permissions.** The bot's role needs **Manage Roles, Manage Channels, Manage
   Nicknames** (plus the View/Send it already has for the feed). Drag the bot's role **above**
   every player role it must rename and above where clan roles will appear (new roles are
   created at the bottom, so this holds unless someone moves them).
3. **Create by hand, once:** a text category (e.g. `CLANS`), a voice category (e.g. `CLAN VOICE`),
   and a role `Linked`. Copy their ids into the bot `.env`:
       CLAN_TEXT_CATEGORY_ID=…
       CLAN_VOICE_CATEGORY_ID=…
       LINKED_ROLE_ID=…
   The bot refuses to start with any of the three missing or malformed.
4. **Deploy** the bot: `sudo systemctl restart clan-wars-bot`. The web image is unchanged by
   this increment; deploy it only if 3a's runbook has not been applied yet (do that first).
5. **Confirm on start:** `journalctl -u clan-wars-bot -f` shows `guild members fetched: N`, then
   `structure on start: created X, linkedAdds Y …` — X is the number of active/dormant clans,
   Y the number of linked players in the guild. Every existing linked player now holds
   `@Linked`; every full member holds their clan's role; each clan has `#clan-{tag}` and a
   voice channel visible only to its role.
6. **Confirm delivery:** channel notices 3a has been queueing with a null target drain in id
   order on the next notice tick:
       select count(*) from clan_notices where posted_at is null and failed_at is null and target = 'channel';
   trends to 0. A row that fails three times is `failed_at`-stamped and logged.
7. **Acceptance.** Kick a test member on the site: within a tick they lose the clan role and
   the channel shows the `kicked` line. Unlink a test account on the site (`/me`): within a
   tick `@Linked` is gone and the nickname is cleared. Disband a test clan: its channels and
   role vanish, and `factions.discord_*_id` are null. Rename a clan: role and channels follow.
8. **If someone deletes a clan channel by hand**, the bot logs `structure: missing:<id>` once
   per tick and does not recreate it (an operator's deletion is a decision). To have it
   recreated: `update factions set discord_text_channel_id = null where id = …;` — the next
   tick creates a fresh one.
9. **What waits.** `[TAG]` nickname prefixes, `@Alpha`, guest-pass overwrites and the
   guild-removal handler are increments 4 and 7.
```

- [ ] **Step 2: CLAUDE.md** — under the consumers/ticks bullet add: "`structure-tick.ts` (3b): a reconciler, not a queue — derives roles/channels/`@Linked` from `factions`, `faction_members` (full only) and `identity_links`, diffs against the guild cache, writes only differences; the only writer of `factions.discord_*_id`. `guild.ts` is the only file that calls discord.js role/channel/member APIs." Hazards: "Hand-deleted clan channels are logged, not recreated; null the column to recreate." Env: the three required ids and the Server Members Intent. Current state: "Increment 3b merged; not deployed until `docs/deploy/2026-09-06-discord-structure.md`."
- [ ] **Step 3: Spec §15** row 3b: plan file `2026-09-06-discord-structure.md`. Nothing else in the spec changes.
- [ ] **Step 4:** Full gate → 26/26. Commit:

```bash
git add docs/deploy/2026-09-06-discord-structure.md CLAUDE.md docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md apps/bot/README.md
git commit -m "docs: 3b runbook; CLAUDE.md for the Discord reconciler; spec §15 names the plan"
```

---

## Self-review

**Spec coverage.** §9.1 structure per clan (Task 4 step 1), visible only to the role (Task 2 overwrites), `@Linked` on link / off on unlink (Task 4 step 5), required env (Task 1), nickname clear on a site unlink (Task 4 step 5 — the site's `unlinkDb` deletes the link row; the reconciler sees it), `[TAG]` prefix deferred to 7 as §15 says. §5.1 created at activation / deleted at disband (Task 4 steps 1–2; reserved clans excluded; lapsed and disbanded both tear down — a lapsed reservation never had structures, so the delete branch is a no-op there). §5.3 role removed on leave/kick (step 4 diff; no roster-store change needed because the row is deleted). §7 "activation + lapse … Discord role + text + voice channel" and "presence … role" both satisfied by the diff within one tick of the transition (10 s) — an accepted deviation from "in the same step", ruled here: a reconciler is what §9.1 asks for and it makes every path (site, bot, hand edits) converge. §5.6 guest-pass reconciliation is increment 7's, but the reconciler is the place it will hang off. §14 disband confirmation (Task 6); hand-deleted channel hazard (runbook 8). §15 row 3b "the channel target for queued notices": 3a's `readUnposted` coalesce already resolves it; Task 4's last test proves the end-to-end.

**Placeholders.** Two tests in Task 4 are given as comments with the exact assertions named (reserved clan; already-deleted object; member not in guild); every other test is complete. No TBDs.

**Type consistency.** `GuildGateway` (Task 2) is what `structureTick` (Task 4) takes and `createGuildGateway` (Task 2) / `FakeGuild` (Task 4) implement; `StructureStore` (Task 3) is what `structureTick` reads and `PgStructureStore` implements; `NicknameOutcome` is `nickname.ts`'s existing union, re-exported from `guild.ts`; the three config fields (Task 1) are read by name in Task 5.
