import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createClient,
  runMigrations,
  requireTestDatabaseUrl,
  servers,
  factions,
  factionMembers,
  identityLinks,
  guestPasses,
  clanNotices,
  seasons,
  alphaWeeks,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { noticeClanTx, PgNoticeStore } from "@factions/roster/internal";
import { PgStructureStore, type StructureStore } from "../src/structure-store.js";
import { structureTick } from "../src/structure-tick.js";
import type { GuildGateway } from "../src/guild.js";
import { seedFaction } from "./seed.js";
import { FakeGuild } from "./fake-guild.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-06T12:00:00Z");

describe("structureTick", () => {
  let db: Database;
  let store: PgStructureStore;
  let guild: FakeGuild;
  let serverId = 0;
  let BEAR = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(
        sql`truncate table clan_notices, alpha_weeks, seasons, identity_links, guest_passes, faction_members, declarations, poles, events, adm_files, factions, servers restart identity cascade`,
      );
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    store = new PgStructureStore(db);

    const bear = await seedFaction(db, { serverId, name: "Night Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", createdAt: now });
    BEAR = bear.id;
    await db.insert(factionMembers).values([
      { factionId: BEAR, serverId, dayzId: "U1", discordId: "d1", role: "leader", joinedAt: now, status: "full" },
      { factionId: BEAR, serverId, dayzId: "U2", discordId: "d2", role: "member", joinedAt: now, status: "full" },
      { factionId: BEAR, serverId, dayzId: "U3", discordId: "d3", role: "member", joinedAt: now, status: "pending" },
    ]);
    await db.insert(identityLinks).values([
      { discordId: "d1", dayzId: "U1", gamertag: "One", verifiedAt: now },
      { discordId: "d2", dayzId: "U2", gamertag: "Two", verifiedAt: now },
      { discordId: "d4", dayzId: "U4", gamertag: "Four", verifiedAt: now },
    ]);

    guild = new FakeGuild();
    guild.roles.set("linked", { name: "Linked", members: new Set() });
    guild.roles.set("alpha", { name: "Alpha", members: new Set() });
    for (const id of ["d1", "d2", "d3", "d4"]) guild.members.set(id, { nickname: null });
  });

  it("creates role, text and voice channel for an active clan and records the ids", async () => {
    const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    expect(r).toMatchObject({ created: 1, errors: 0 });
    const [row] = await store.clansWithStructure();
    expect(row).toMatchObject({ id: BEAR });
    expect(guild.roles.get(row!.roleId!)!.name).toBe("Night Bears");
    expect(guild.channels.get(row!.textChannelId!)).toMatchObject({ name: "clan-bear", kind: "text", roleId: row!.roleId });
    expect(guild.channels.get(row!.voiceChannelId!)).toMatchObject({ name: "BEAR", kind: "voice", roleId: row!.roleId });
  });

  it("⚠️ resumes a half-created clan without duplicating the role", async () => {
    guild.failNext.add("createTextChannel");
    let r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    expect(r).toMatchObject({ created: 0, errors: 1 });
    const [half] = await store.clansNeedingStructure();
    expect(half).toMatchObject({ roleId: expect.any(String), textChannelId: null });
    r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    expect(r).toMatchObject({ created: 1, errors: 0 });
    expect(guild.calls.filter((c) => c.startsWith("createRole"))).toHaveLength(1);
  });

  it("does not create structures for a reserved clan (§5.1: at activation)", async () => {
    await db.update(factions).set({ status: "reserved", reservedUntil: new Date(now.getTime() + 86400000) }).where(eq(factions.id, BEAR));
    const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    expect(r).toMatchObject({ created: 0, errors: 0 });
    expect(await store.clansWithStructure()).toEqual([]);
    expect(guild.calls.filter((c) => c.startsWith("create"))).toEqual([]);
  });

  it("tears a disbanded clan down, channels before the role, and nulls the ids", async () => {
    await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    await db.update(factions).set({ status: "disbanded" }).where(eq(factions.id, BEAR));
    const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    expect(r).toMatchObject({ tornDown: 1 });
    expect(guild.roles.size).toBe(2); // only Linked and Alpha remain
    expect(guild.channels.size).toBe(0);
    const [f] = await db.select({ r: factions.discordRoleId, t: factions.discordTextChannelId, v: factions.discordVoiceChannelId }).from(factions).where(eq(factions.id, BEAR));
    expect(f).toEqual({ r: null, t: null, v: null });
    const order = guild.calls.filter((c) => c.startsWith("delete"));
    expect(order[2]).toMatch(/^deleteRole/u);
  });

  it("tolerates an object already deleted by hand during teardown", async () => {
    await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    const [row] = await store.clansWithStructure();
    guild.channels.delete(row!.textChannelId!);
    await db.update(factions).set({ status: "disbanded" }).where(eq(factions.id, BEAR));
    const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    expect(r).toMatchObject({ tornDown: 1, errors: 0 });
    const [f] = await db.select({ r: factions.discordRoleId, t: factions.discordTextChannelId, v: factions.discordVoiceChannelId }).from(factions).where(eq(factions.id, BEAR));
    expect(f).toEqual({ r: null, t: null, v: null });
  });

  it("renames the role and channels after a clan rename", async () => {
    await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    await db.update(factions).set({ name: "Day Bears", tag: "DAYB" }).where(eq(factions.id, BEAR));
    const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    expect(r).toMatchObject({ renamed: 1 });
    const [row] = await store.clansWithStructure();
    expect(guild.roles.get(row!.roleId!)!.name).toBe("Day Bears");
    expect(guild.channels.get(row!.textChannelId!)!.name).toBe("clan-dayb");
    expect(guild.channels.get(row!.voiceChannelId!)!.name).toBe("DAYB");
  });

  it("gives the clan role to full members only, and takes it back after a leave", async () => {
    let r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    const [row] = await store.clansWithStructure();
    expect([...guild.roleMembers(row!.roleId!)].sort()).toEqual(["d1", "d2"]); // d3 is pending
    expect(r.roleAdds).toBe(2);
    await db.delete(factionMembers).where(eq(factionMembers.discordId, "d2"));
    r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    expect(r.roleRemoves).toBe(1);
    expect([...guild.roleMembers(row!.roleId!)]).toEqual(["d1"]);
  });

  it("gives a clan's stale role holders back even after its last full member left (inner-join gap)", async () => {
    await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    await db.delete(factionMembers).where(eq(factionMembers.factionId, BEAR));
    const [row] = await store.clansWithStructure();
    expect([...guild.roleMembers(row!.roleId!)].sort()).toEqual(["d1", "d2"]);
    const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    expect(r.roleRemoves).toBe(2);
    expect(guild.roleMembers(row!.roleId!).size).toBe(0);
  });

  it("skips a full member who is not in the guild, without an error", async () => {
    await db.insert(factionMembers).values({
      factionId: BEAR, serverId, dayzId: "U9", discordId: "d9", role: "member", joinedAt: now, status: "full",
    });
    const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    expect(r.errors).toBe(0);
    expect(guild.calls.filter((c) => c.includes("d9"))).toEqual([]);
    const [row] = await store.clansWithStructure();
    expect(guild.roleMembers(row!.roleId!).has("d9")).toBe(false);
  });

  it("gives @Linked to every link row and, on unlink, clears the nickname THEN removes the role", async () => {
    guild.members.get("d4")!.nickname = "Four";
    let r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    expect([...guild.roleMembers("linked")].sort()).toEqual(["d1", "d2", "d4"]);
    expect(r.linkedAdds).toBe(3);
    await db.delete(identityLinks).where(eq(identityLinks.discordId, "d4")); // what unlinkDb does
    r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    expect(r).toMatchObject({ linkedRemoves: 1, nicknamesCleared: 1 });
    expect(guild.members.get("d4")!.nickname).toBeNull();
    const i = guild.calls.indexOf("setNickname d4 null");
    expect(i).toBeGreaterThan(-1);
    expect(guild.calls[i + 1]).toBe("removeRole d4 linked");
  });

  it("⚠️ an unrenamable user is logged once, never retried, and still loses the role", async () => {
    await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    guild.nicknameOutcome = "outranked";
    const noRetry = new Set<string>();
    const onError = vi.fn();
    await db.delete(identityLinks).where(eq(identityLinks.discordId, "d4"));
    await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha", nicknameNoRetry: noRetry, onError });
    expect(noRetry.has("d4")).toBe(true);
    expect(guild.roleMembers("linked").has("d4")).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    // a second unlink of the same user (relinked in between) must not log again
    await db.insert(identityLinks).values({ discordId: "d4", dayzId: "U4", gamertag: "Four", verifiedAt: now });
    await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha", nicknameNoRetry: noRetry, onError });
    await db.delete(identityLinks).where(eq(identityLinks.discordId, "d4"));
    await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha", nicknameNoRetry: noRetry, onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(guild.calls.filter((c) => c === "setNickname d4 null")).toHaveLength(1);
  });

  it("one Discord failure does not stop the rest of the pass, and the tick never throws", async () => {
    guild.failNext.add("addRole");
    const onError = vi.fn();
    const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha", onError });
    expect(r.errors).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(r.created).toBe(1); // the create step before it ran
    expect(r.linkedAdds).toBe(3); // the step after it ran
  });

  it("is a no-op on a second pass with nothing changed", async () => {
    await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    guild.calls.length = 0;
    const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    expect(r).toEqual({
      created: 0, tornDown: 0, renamed: 0, roleAdds: 0, roleRemoves: 0, linkedAdds: 0, linkedRemoves: 0,
      alphaAdds: 0, alphaRemoves: 0, nicknamesCleared: 0, noticesFailed: 0,
      guestGrants: 0, guestRevokes: 0, guestConverted: 0, nicknamesSet: 0, errors: 0,
    });
    expect(guild.calls).toEqual([]);
  });

  it("⚠️ a channel notice queued before the channel existed becomes deliverable once it does (3a's null-target rule)", async () => {
    await db.transaction((tx) => noticeClanTx(tx, { serverId, factionId: BEAR, kind: "joined", occurredAt: now, payload: { gamertag: "Two" } }));
    const notices = new PgNoticeStore(db);
    expect(await notices.readUnposted(10)).toEqual([]);
    await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    const [row] = await store.clansWithStructure();
    const [n] = await notices.readUnposted(10);
    expect(n).toMatchObject({ kind: "joined", target: "channel", discordTargetId: row!.textChannelId });
  });
  it("⚠️ adopts a role that already carries the clan's exact name instead of creating a second one", async () => {
    // The shape of a create whose column write was lost: the object exists, no
    // clan owns it, and the name matches exactly.
    guild.roles.set("stray", { name: "Night Bears", members: new Set() });
    const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    expect(r).toMatchObject({ created: 1, errors: 0 });
    const [row] = await store.clansWithStructure();
    expect(row!.roleId).toBe("stray");
    expect(guild.calls.filter((c) => c.startsWith("createRole"))).toEqual([]);
  });

  it("⚠️ a role-id write that keeps failing does not create a second role every tick", async () => {
    const broken: StructureStore = {
      clansNeedingStructure: () => store.clansNeedingStructure(),
      clansToTearDown: () => store.clansToTearDown(),
      clansWithStructure: () => store.clansWithStructure(),
      setRoleId: async () => { throw new Error("lock timeout on factions"); },
      setTextChannelId: (id, v) => store.setTextChannelId(id, v),
      setVoiceChannelId: (id, v) => store.setVoiceChannelId(id, v),
      fullMembersByClan: () => store.fullMembersByClan(),
      fullMembersOf: (ids) => store.fullMembersOf(ids),
      currentAlphaFactionIds: () => store.currentAlphaFactionIds(),
      linkedDiscordIds: () => store.linkedDiscordIds(),
      failChannelNotices: (id, at) => store.failChannelNotices(id, at),
      openGuestPassesByVoiceChannel: (now) => store.openGuestPassesByVoiceChannel(now),
      convertGuestPasses: (now) => store.convertGuestPasses(now),
      desiredNicknames: () => store.desiredNicknames(),
    };
    for (let i = 0; i < 3; i++) {
      const r = await structureTick(broken, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
      expect(r).toMatchObject({ created: 0, errors: 1 });
    }
    // One role, adopted by name on every tick after the first, not three.
    expect(guild.calls.filter((c) => c.startsWith("createRole"))).toHaveLength(1);
    expect(guild.roles.size).toBe(3); // Linked + Alpha + the one clan role
  });

  it("⚠️ a role deleted by hand is reported once, not recreated, and step 4 stops diffing against it", async () => {
    await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    const [row] = await store.clansWithStructure();
    guild.roles.delete(row!.roleId!);
    guild.calls.length = 0;
    const onError = vi.fn();
    const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha", onError });
    expect(onError.mock.calls.map((c) => c[0])).toEqual([`missing:${row!.roleId}`]);
    expect(guild.calls.filter((c) => c.startsWith("createRole"))).toEqual([]);
    // Without the skip this is one guaranteed-10011 addRole per full member, per tick, forever.
    expect(guild.calls.filter((c) => c.startsWith("addRole"))).toEqual([]);
    expect(r).toMatchObject({ created: 0, roleAdds: 0, roleRemoves: 0, errors: 0 });
  });

  it("⚠️ teardown fails the clan's queued channel notices before the channel column goes null", async () => {
    await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    await db.transaction((tx) => noticeClanTx(tx, { serverId, factionId: BEAR, kind: "joined", occurredAt: now, payload: { gamertag: "Two" } }));
    const notices = new PgNoticeStore(db);
    expect(await notices.readUnposted(10)).toHaveLength(1);

    await db.update(factions).set({ status: "disbanded" }).where(eq(factions.id, BEAR));
    const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
    expect(r).toMatchObject({ tornDown: 1, noticesFailed: 1, errors: 0 });

    // Without the stamp this row matches neither readUnposted (the channel
    // column it coalesces onto is null) nor any cleanup — stuck forever, and
    // counted forever by countUnpostedNotices.
    expect(await notices.readUnposted(10)).toEqual([]);
    const [n] = await db.select({ failedAt: clanNotices.failedAt }).from(clanNotices);
    expect(n!.failedAt).not.toBeNull();
  });

  it("⚠️ never throws when the guild cache reads throw, and still returns a full result", async () => {
    // What `cachedGuild()` does when `guilds.fetch` failed at start-up.
    const blind: GuildGateway = {
      fetchAllMembers: () => guild.fetchAllMembers(),
      createRole: (n) => guild.createRole(n),
      createTextChannel: (n, r) => guild.createTextChannel(n, r),
      createVoiceChannel: (n, r) => guild.createVoiceChannel(n, r),
      deleteRole: (i) => guild.deleteRole(i),
      deleteChannel: (i) => guild.deleteChannel(i),
      roleName: (i) => guild.roleName(i),
      channelName: (i) => guild.channelName(i),
      findRoleByName: (n) => guild.findRoleByName(n),
      findChannelByName: (n, k) => guild.findChannelByName(n, k),
      renameRole: (i, n) => guild.renameRole(i, n),
      renameChannel: (i, n) => guild.renameChannel(i, n),
      roleMembers: () => { throw new Error("guild not fetched yet"); },
      isMember: () => { throw new Error("guild not fetched yet"); },
      addRole: (u, r) => guild.addRole(u, r),
      removeRole: (u, r) => guild.removeRole(u, r),
      setNickname: (u, n) => guild.setNickname(u, n),
      // Not cache-backed by "guild not fetched" in this fake: both return the
      // documented "unknown"/"not cached" values rather than throwing, same
      // as `roleName`/`channelName` above.
      memberOverwrites: () => new Set<string>(),
      grantVoiceAccess: (i, u) => guild.grantVoiceAccess(i, u),
      revokeVoiceAccess: (i, u) => guild.revokeVoiceAccess(i, u),
      memberNickname: () => undefined,
    };
    const onError = vi.fn();
    const r = await structureTick(store, blind, { linkedRoleId: "linked", alphaRoleId: "alpha", onError });
    expect(r).toEqual({
      created: 1, tornDown: 0, renamed: 0,
      roleAdds: 0, roleRemoves: 0,
      linkedAdds: 0, linkedRemoves: 0,
      alphaAdds: 0, alphaRemoves: 0,
      nicknamesCleared: 0, noticesFailed: 0,
      guestGrants: 0, guestRevokes: 0, guestConverted: 0, nicknamesSet: 0,
      // step 4's isMember, step 5's read, step 6's read, step 8's read — the pass still finishes
      errors: 4,
    });
    expect(onError.mock.calls.map((c) => c[0])).toEqual([`roles:${BEAR}`, "linked-read", "alpha-read", "nickname-read"]);
  });

  describe("guest passes (step 7)", () => {
    it("grants access for an open pass, is a no-op on the second pass, and revokes a stray with no pass", async () => {
      await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha", now: () => now });
      const [row] = await store.clansWithStructure();
      const voiceId = row!.voiceChannelId!;
      guild.overwrites.set(voiceId, new Set(["d8"])); // stray: no pass behind it
      await db.insert(guestPasses).values({
        factionId: BEAR, discordUserId: "d9", grantedByDiscordId: "d1", grantedAt: now,
        expiresAt: new Date(now.getTime() + 1000),
      });

      guild.calls.length = 0;
      let r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha", now: () => now });
      expect(r).toMatchObject({ guestGrants: 1, guestRevokes: 1 });
      expect(guild.calls).toContain(`grantVoiceAccess ${voiceId} d9`);
      expect(guild.calls).toContain(`revokeVoiceAccess ${voiceId} d8`);
      expect(guild.overwrites.get(voiceId)).toEqual(new Set(["d9"]));

      // Cache already matches: no REST call at all.
      guild.calls.length = 0;
      r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha", now: () => now });
      expect(r).toMatchObject({ guestGrants: 0, guestRevokes: 0 });
      expect(guild.calls.filter((c) => c.includes("VoiceAccess"))).toEqual([]);

      // Expired: revoked.
      await db.update(guestPasses).set({ expiresAt: new Date(now.getTime() - 1) }).where(eq(guestPasses.discordUserId, "d9"));
      r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha", now: () => now });
      expect(r).toMatchObject({ guestRevokes: 1 });
      expect(guild.overwrites.get(voiceId)).toEqual(new Set());
    });

    it("converts a pass once its user is a full member; the overwrite is revoked and converted_at stamped", async () => {
      await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha", now: () => now });
      const [row] = await store.clansWithStructure();
      const voiceId = row!.voiceChannelId!;
      const [pass] = await db.insert(guestPasses).values({
        factionId: BEAR, discordUserId: "d9", grantedByDiscordId: "d1", grantedAt: now,
        expiresAt: new Date(now.getTime() + 100000),
      }).returning();
      await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha", now: () => now });
      expect(guild.overwrites.get(voiceId)).toEqual(new Set(["d9"]));

      await db.insert(factionMembers).values({
        factionId: BEAR, serverId, dayzId: "U9", discordId: "d9", role: "member", joinedAt: now, status: "full",
      });
      const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha", now: () => now });
      expect(r).toMatchObject({ guestConverted: 1, guestRevokes: 1 });
      expect(guild.overwrites.get(voiceId)).toEqual(new Set());
      const [after] = await db.select({ convertedAt: guestPasses.convertedAt }).from(guestPasses).where(eq(guestPasses.id, pass!.id));
      expect(after!.convertedAt).not.toBeNull();
    });
  });

  describe("nicknames (step 8)", () => {
    it("prefixes a full member, bares a linked non-member and a pending member, and skips an already-correct entry", async () => {
      await db.insert(identityLinks).values({ discordId: "d3", dayzId: "U3", gamertag: "Three", verifiedAt: now });
      guild.members.get("d1")!.nickname = "One"; // full member of BEAR → desired "[BEAR] One"
      guild.members.get("d2")!.nickname = "[BEAR] Two"; // full member, already correct
      guild.members.get("d4")!.nickname = "[BEAR] Four"; // linked, no clan → desired bare "Four"
      // d3 (pending, no clan standing) keeps its beforeEach null nickname → desired bare "Three"

      const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha", now: () => now });

      expect(guild.calls).toContain("setNickname d1 [BEAR] One");
      expect(guild.calls).toContain("setNickname d4 Four");
      expect(guild.calls).toContain("setNickname d3 Three");
      expect(guild.calls.filter((c) => c.startsWith("setNickname d2"))).toEqual([]);
      expect(r.nicknamesSet).toBe(3);
    });

    it("never retries a user in nicknameNoRetry", async () => {
      guild.members.get("d1")!.nickname = "One"; // mismatched — would otherwise become "[BEAR] One"
      const noRetry = new Set<string>(["d1"]);
      const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha", now: () => now, nicknameNoRetry: noRetry });
      expect(guild.calls.filter((c) => c.startsWith("setNickname d1"))).toEqual([]);
      // d2 and d4 still get theirs — nicknameNoRetry gates d1 only.
      expect(r.nicknamesSet).toBe(2);
    });

    it("truncates a 40-char gamertag so the nickname is exactly 32 chars, tag intact", async () => {
      const longName = "X".repeat(40);
      await db.insert(identityLinks).values({ discordId: "d5", dayzId: "U5", gamertag: longName, verifiedAt: now });
      await db.insert(factionMembers).values({
        factionId: BEAR, serverId, dayzId: "U5", discordId: "d5", role: "member", joinedAt: now, status: "full",
      });
      guild.members.set("d5", { nickname: null });

      await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha", now: () => now });

      expect(guild.members.get("d5")!.nickname).toHaveLength(32);
      expect(guild.members.get("d5")!.nickname!.startsWith("[BEAR] ")).toBe(true);
    });
  });

  describe("@Alpha", () => {
    let WOLF = 0;
    const week1 = new Date("2026-08-24T00:00:00Z");
    const week2 = new Date("2026-08-31T00:00:00Z");

    beforeEach(async () => {
      const wolf = await seedFaction(db, { serverId, name: "Wolf Pack", tag: "WOLF", texture: "Flag_Wolf", status: "active", createdAt: now, poleKey: "2.00:1.00:2.00" });
      WOLF = wolf.id;
      await db.insert(factionMembers).values([
        { factionId: WOLF, serverId, dayzId: "U5", discordId: "d5", role: "leader", joinedAt: now, status: "full" },
        { factionId: WOLF, serverId, dayzId: "U6", discordId: "d6", role: "member", joinedAt: now, status: "pending" },
      ]);
      guild.members.set("d5", { nickname: null });
      guild.members.set("d6", { nickname: null });
    });

    it("gives @Alpha to the full members of this week's Alphas and takes it from last week's", async () => {
      const [season] = await db.insert(seasons).values({
        serverId, number: 1, startedAt: week1, weekClosedThrough: week1,
      }).returning();
      await db.insert(alphaWeeks).values({ seasonId: season!.id, weekStart: week1, rank: 1, factionId: BEAR, points: 10 });
      let r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
      expect([...guild.roleMembers("alpha")].sort()).toEqual(["d1", "d2"]); // BEAR's full members
      expect(r.alphaAdds).toBe(2);

      await db.update(seasons).set({ weekClosedThrough: week2 }).where(eq(seasons.id, season!.id));
      await db.insert(alphaWeeks).values({ seasonId: season!.id, weekStart: week2, rank: 1, factionId: WOLF, points: 20 });
      r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
      expect([...guild.roleMembers("alpha")].sort()).toEqual(["d5"]); // WOLF's full member only; d6 is pending
      expect(r.alphaAdds).toBe(1);
      expect(r.alphaRemoves).toBe(2);
    });

    it("no closed week means nobody holds @Alpha", async () => {
      await db.insert(seasons).values({ serverId, number: 1, startedAt: week1, weekClosedThrough: null });
      guild.roles.get("alpha")!.members.add("d5"); // stale holder from a prior tick
      const r = await structureTick(store, guild, { linkedRoleId: "linked", alphaRoleId: "alpha" });
      expect(guild.roleMembers("alpha")).toEqual(new Set());
      expect(r.alphaRemoves).toBe(1);
      expect(r.alphaAdds).toBe(0);
    });
  });
});
