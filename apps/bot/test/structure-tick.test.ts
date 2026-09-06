import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createClient,
  runMigrations,
  requireTestDatabaseUrl,
  servers,
  factions,
  factionMembers,
  identityLinks,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { noticeClanTx, PgNoticeStore } from "@factions/roster/internal";
import { PgStructureStore } from "../src/structure-store.js";
import { structureTick } from "../src/structure-tick.js";
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
        sql`truncate table clan_notices, identity_links, faction_members, declarations, poles, events, adm_files, factions, servers restart identity cascade`,
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
    for (const id of ["d1", "d2", "d3", "d4"]) guild.members.set(id, { nickname: null });
  });

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

  it("does not create structures for a reserved clan (§5.1: at activation)", async () => {
    await db.update(factions).set({ status: "reserved", reservedUntil: new Date(now.getTime() + 86400000) }).where(eq(factions.id, BEAR));
    const r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect(r).toMatchObject({ created: 0, errors: 0 });
    expect(await store.clansWithStructure()).toEqual([]);
    expect(guild.calls.filter((c) => c.startsWith("create"))).toEqual([]);
  });

  it("tears a disbanded clan down, channels before the role, and nulls the ids", async () => {
    await structureTick(store, guild, { linkedRoleId: "linked" });
    await db.update(factions).set({ status: "disbanded" }).where(eq(factions.id, BEAR));
    const r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect(r).toMatchObject({ tornDown: 1 });
    expect(guild.roles.size).toBe(1); // only Linked remains
    expect(guild.channels.size).toBe(0);
    const [f] = await db.select({ r: factions.discordRoleId, t: factions.discordTextChannelId, v: factions.discordVoiceChannelId }).from(factions).where(eq(factions.id, BEAR));
    expect(f).toEqual({ r: null, t: null, v: null });
    const order = guild.calls.filter((c) => c.startsWith("delete"));
    expect(order[2]).toMatch(/^deleteRole/u);
  });

  it("tolerates an object already deleted by hand during teardown", async () => {
    await structureTick(store, guild, { linkedRoleId: "linked" });
    const [row] = await store.clansWithStructure();
    guild.channels.delete(row!.textChannelId!);
    await db.update(factions).set({ status: "disbanded" }).where(eq(factions.id, BEAR));
    const r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect(r).toMatchObject({ tornDown: 1, errors: 0 });
    const [f] = await db.select({ r: factions.discordRoleId, t: factions.discordTextChannelId, v: factions.discordVoiceChannelId }).from(factions).where(eq(factions.id, BEAR));
    expect(f).toEqual({ r: null, t: null, v: null });
  });

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
    expect([...guild.roleMembers(row!.roleId!)].sort()).toEqual(["d1", "d2"]); // d3 is pending
    expect(r.roleAdds).toBe(2);
    await db.delete(factionMembers).where(eq(factionMembers.discordId, "d2"));
    r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect(r.roleRemoves).toBe(1);
    expect([...guild.roleMembers(row!.roleId!)]).toEqual(["d1"]);
  });

  it("gives a clan's stale role holders back even after its last full member left (inner-join gap)", async () => {
    await structureTick(store, guild, { linkedRoleId: "linked" });
    await db.delete(factionMembers).where(eq(factionMembers.factionId, BEAR));
    const [row] = await store.clansWithStructure();
    expect([...guild.roleMembers(row!.roleId!)].sort()).toEqual(["d1", "d2"]);
    const r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect(r.roleRemoves).toBe(2);
    expect(guild.roleMembers(row!.roleId!).size).toBe(0);
  });

  it("skips a full member who is not in the guild, without an error", async () => {
    await db.insert(factionMembers).values({
      factionId: BEAR, serverId, dayzId: "U9", discordId: "d9", role: "member", joinedAt: now, status: "full",
    });
    const r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect(r.errors).toBe(0);
    expect(guild.calls.filter((c) => c.includes("d9"))).toEqual([]);
    const [row] = await store.clansWithStructure();
    expect(guild.roleMembers(row!.roleId!).has("d9")).toBe(false);
  });

  it("gives @Linked to every link row and, on unlink, clears the nickname THEN removes the role", async () => {
    guild.members.get("d4")!.nickname = "Four";
    let r = await structureTick(store, guild, { linkedRoleId: "linked" });
    expect([...guild.roleMembers("linked")].sort()).toEqual(["d1", "d2", "d4"]);
    expect(r.linkedAdds).toBe(3);
    await db.delete(identityLinks).where(eq(identityLinks.discordId, "d4")); // what unlinkDb does
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
    expect(r.created).toBe(1); // the create step before it ran
    expect(r.linkedAdds).toBe(3); // the step after it ran
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
});
