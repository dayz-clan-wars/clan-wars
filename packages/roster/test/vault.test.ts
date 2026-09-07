import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, vaultLocks, vaultHistory, clanNotices,
  identityLinks, players, admFiles,
  type Database,
} from "@factions/db";
import { sql, eq, and, asc } from "drizzle-orm";
import type { ClanNoticeKind } from "@factions/domain";
import {
  addLockDb, editLockDb, deleteLockDb, revealLockDb, rotateLocksDb, confirmLockDb, vaultStateDb,
  type VaultActor,
} from "../src/internal";
import { kickDb, leaveDb } from "../src/writes";
import { seedFaction } from "./seed";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");
const DAY = 86_400_000;

const UID = { L: "L".repeat(40), O1: "O".repeat(40), M1: "1".repeat(40) };
const TAGS: Record<keyof typeof UID, string> = { L: "Leo", O1: "Otto", M1: "Mina" };
const D: Record<keyof typeof UID, string> = { L: "dL", O1: "dO1", M1: "dM1" };

describe("vault store", () => {
  let db: Database;
  let serverId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table vault_history, vault_locks, faction_vote_ballots, faction_votes, succession_claims, clan_notices, faction_join_requests, identity_holds, faction_invites, roster_cooldowns, faction_members, declarations, poles, factions, ceremony_participants, ceremonies, claim_drafts, identity_links, players, events, raw_lines, adm_files, faction_events, servers restart identity cascade`);
    });

    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: now, linesIngested: 0, complete: true });

    const who = Object.keys(UID) as (keyof typeof UID)[];
    await db.insert(players).values(who.map((k) => ({ dayzId: UID[k], gamertag: TAGS[k], firstSeenAt: now, lastSeenAt: now })));
    await db.insert(identityLinks).values(who.map((k) => ({ discordId: D[k], dayzId: UID[k], gamertag: TAGS[k], verifiedAt: now })));

    const f = await seedFaction(db, {
      serverId, tag: "BEAR", name: "Bears", texture: "Flag_Bear",
      leaderDiscordId: D.L, createdAt: now, activatedAt: now,
    });
    factionId = f.id;
    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: UID.L, discordId: D.L, role: "leader", joinedAt: now, status: "full" },
      { factionId, serverId, dayzId: UID.O1, discordId: D.O1, role: "officer", joinedAt: now, status: "full" },
      { factionId, serverId, dayzId: UID.M1, discordId: D.M1, role: "member", joinedAt: now, status: "full" },
    ]);
  });

  afterEach(async () => { await db.$client.end(); });

  const actor = (who: keyof typeof UID): VaultActor => ({
    factionId, serverId, dayzId: UID[who], discordId: D[who],
    role: who === "L" ? "leader" : who === "O1" ? "officer" : "member",
  });

  const notices = async (kind: ClanNoticeKind) => {
    const rows = await db.select({ target: clanNotices.target, payload: clanNotices.payload }).from(clanNotices)
      .where(eq(clanNotices.kind, kind)).orderBy(asc(clanNotices.id));
    return rows.map((r) => ({ target: r.target, payload: r.payload as Record<string, unknown> }));
  };

  const lockRow = async (id: number) => (await db.select().from(vaultLocks).where(eq(vaultLocks.id, id)))[0]!;
  const historyRows = async () => db.select().from(vaultHistory).orderBy(asc(vaultHistory.id));

  // -------------------------------------------------------------- 1. addLock

  it("addLock: officer+ only, deterministic rng, and validation", async () => {
    const added = await addLockDb(db, actor("O1"), { name: "Front gate", note: null, minRole: "member", at: now, rng: () => 0.5 });
    expect(added.outcome).toBe("ok");
    expect(added.lockId).not.toBeNull();
    const row = await lockRow(added.lockId!);
    expect(row.code).toBe("5000");
    expect((await historyRows()).map((h) => h.action)).toEqual(["added"]);

    const byMember = await addLockDb(db, actor("M1"), { name: "Back door", note: null, minRole: "member", at: now });
    expect(byMember.outcome).toBe("not-permitted");

    const badName = await addLockDb(db, actor("O1"), { name: "x".repeat(41), note: null, minRole: "member", at: now });
    expect(badName.outcome).toBe("bad-name");

    const badCode = await addLockDb(db, actor("O1"), { name: "Shed", note: null, minRole: "member", code: "12a4", at: now });
    expect(badCode.outcome).toBe("bad-code");

    const badNote = await addLockDb(db, actor("O1"), { name: "Shed", note: "x".repeat(141), minRole: "member", at: now });
    expect(badNote.outcome).toBe("bad-note");
  });

  // ------------------------------------------------------------- 2. vaultState

  it("vaultState: role-gated locks, never a code, history leader-only", async () => {
    const memberLock = (await addLockDb(db, actor("O1"), { name: "Front gate", note: null, minRole: "member", at: now, rng: () => 0.5 })).lockId!;
    await addLockDb(db, actor("O1"), { name: "Officer safe", note: null, minRole: "officer", at: now, rng: () => 0.1 });

    const forM1 = await vaultStateDb(db, actor("M1"));
    expect(forM1.locks).toHaveLength(1);
    expect(forM1.locks[0]!.id).toBe(memberLock);
    expect(forM1.locks[0]).not.toHaveProperty("code");
    expect(forM1.history).toBeNull();

    const forO1 = await vaultStateDb(db, actor("O1"));
    expect(forO1.locks).toHaveLength(2);
    expect(forO1.history).toBeNull();

    const forL = await vaultStateDb(db, actor("L"));
    expect(forL.locks).toHaveLength(2);
    expect(forL.history).not.toBeNull();
    expect(Array.isArray(forL.history)).toBe(true);
  });

  // ------------------------------------------------------------- 3. revealLock

  it("revealLock: not-visible below min_role, ok with the code at/above it", async () => {
    const memberLock = (await addLockDb(db, actor("O1"), { name: "Front gate", note: null, minRole: "member", at: now, rng: () => 0.5 })).lockId!;
    const officerLock = (await addLockDb(db, actor("O1"), { name: "Officer safe", note: null, minRole: "officer", at: now, rng: () => 0.1 })).lockId!;

    const blocked = await revealLockDb(db, actor("M1"), { lockId: officerLock, at: now });
    expect(blocked).toEqual({ outcome: "not-visible", code: null });

    const ok = await revealLockDb(db, actor("M1"), { lockId: memberLock, at: now });
    expect(ok.outcome).toBe("ok");
    expect(ok.code).toMatch(/^[0-9]{4}$/u);

    const hist = await historyRows();
    expect(hist.filter((h) => h.action === "revealed")).toHaveLength(1);
  });

  // ------------------------------------------------------------- 4. rotateLocks

  it("rotateLocks: rotates every lock, one channel notice, one DM per full member, no code anywhere; confirmLock flips changedInGame", async () => {
    const memberLock = (await addLockDb(db, actor("O1"), { name: "Front gate", note: null, minRole: "member", at: now, rng: () => 0.5 })).lockId!;
    const officerLock = (await addLockDb(db, actor("O1"), { name: "Officer safe", note: null, minRole: "officer", at: now, rng: () => 0.1 })).lockId!;

    const before = await Promise.all([lockRow(memberLock), lockRow(officerLock)]);

    const rotated = await rotateLocksDb(db, actor("O1"), { lockId: "all", at: now, rng: () => 0.9 });
    expect(rotated).toEqual({ outcome: "ok", rotated: 2 });

    const after = await Promise.all([lockRow(memberLock), lockRow(officerLock)]);
    expect(after[0]!.code).not.toBe(before[0]!.code);
    expect(after[1]!.code).not.toBe(before[1]!.code);
    expect(after[0]!.confirmedAt).toBeNull();
    expect(after[1]!.confirmedAt).toBeNull();

    const state = await vaultStateDb(db, actor("O1"));
    for (const l of state.locks) expect(l.changedInGame).toBe(true);

    const channel = await notices("codes_rotated");
    const channelNotices = channel.filter((n) => n.target === "channel");
    const dmNotices = channel.filter((n) => n.target === "dm");
    expect(channelNotices).toHaveLength(1);
    expect(dmNotices).toHaveLength(3); // L, O1, M1 — all full members

    const allJson = JSON.stringify(channel);
    expect(allJson).not.toMatch(/\d{4}/u);
    for (const n of dmNotices) expect((n.payload as { link: string }).link.endsWith("/clan/vault")).toBe(true);

    const confirmed = await confirmLockDb(db, actor("M1"), { lockId: memberLock, at: new Date(now.getTime() + 1000) });
    expect(confirmed).toBe("ok");
    const stateAfterConfirm = await vaultStateDb(db, actor("O1"));
    const view = stateAfterConfirm.locks.find((l) => l.id === memberLock)!;
    expect(view.changedInGame).toBe(false);
  });

  // ------------------------------------------------------------- 5. deleteLock

  it("deleteLock: gone, and history keeps the frozen name with lock_id null", async () => {
    const lockId = (await addLockDb(db, actor("O1"), { name: "Front gate", note: null, minRole: "member", at: now, rng: () => 0.5 })).lockId!;

    expect(await deleteLockDb(db, actor("O1"), { lockId, at: now })).toBe("ok");
    expect(await lockRow(lockId)).toBeUndefined();

    const hist = (await historyRows()).find((h) => h.action === "deleted")!;
    expect(hist.lockId).toBeNull();
    expect(hist.lockName).toBe("Front gate");
  });

  // ------------------------------------------------------------- 6. exposure

  it("exposure: a leaver exposes only the locks they could see; rotate clears exposed_at", async () => {
    const memberLock = (await addLockDb(db, actor("O1"), { name: "Front gate", note: null, minRole: "member", at: now, rng: () => 0.5 })).lockId!;
    const officerLock = (await addLockDb(db, actor("O1"), { name: "Officer safe", note: null, minRole: "officer", at: now, rng: () => 0.1 })).lockId!;

    expect(await leaveDb(db, now, D.M1)).toBe("ok");
    expect((await lockRow(memberLock)).exposedAt).not.toBeNull();
    expect((await lockRow(officerLock)).exposedAt).toBeNull();

    // Re-add O1 as officer would already be gone from kick below; instead
    // kick O1 (an officer) by the leader and confirm both locks expose.
    expect(await kickDb(db, now, D.L, D.O1)).toBe("ok");
    expect((await lockRow(memberLock)).exposedAt).not.toBeNull();
    expect((await lockRow(officerLock)).exposedAt).not.toBeNull();

    const stateBefore = await vaultStateDb(db, actor("L"));
    expect(stateBefore.locks.find((l) => l.id === memberLock)!.exposed).toBe(true);
    expect(stateBefore.locks.find((l) => l.id === officerLock)!.exposed).toBe(true);

    const rotated = await rotateLocksDb(db, actor("L"), { lockId: "all", at: now, rng: () => 0.2 });
    expect(rotated.outcome).toBe("ok");
    expect((await lockRow(memberLock)).exposedAt).toBeNull();
    expect((await lockRow(officerLock)).exposedAt).toBeNull();
  });

  it("editLock: officer+ only, validates, and gone for a missing lock", async () => {
    const lockId = (await addLockDb(db, actor("O1"), { name: "Front gate", note: null, minRole: "member", at: now, rng: () => 0.5 })).lockId!;

    expect(await editLockDb(db, actor("M1"), { lockId, name: "x", note: null, minRole: "member", at: now })).toBe("not-permitted");
    expect(await editLockDb(db, actor("O1"), { lockId, name: "x".repeat(41), note: null, minRole: "member", at: now })).toBe("bad-name");
    expect(await editLockDb(db, actor("O1"), { lockId, name: "Front gate 2", note: "note", minRole: "officer", at: now })).toBe("ok");

    const row = await lockRow(lockId);
    expect(row.name).toBe("Front gate 2");
    expect(row.minRole).toBe("officer");

    expect(await editLockDb(db, actor("O1"), { lockId: lockId + 9999, name: "x", note: null, minRole: "member", at: now })).toBe("gone");
  });

  // ------------------------------------------------------- 7. stale actor

  it("re-derives the actor's role from faction_members, never trusting a stale VaultActor", async () => {
    const staleOfficer = actor("O1"); // built before the demotion below

    await db.update(factionMembers).set({ role: "member" })
      .where(and(eq(factionMembers.factionId, factionId), eq(factionMembers.dayzId, UID.O1)));

    const added = await addLockDb(db, staleOfficer, { name: "Front gate", note: null, minRole: "member", at: now, rng: () => 0.5 });
    expect(added.outcome).toBe("not-permitted");

    const rotated = await rotateLocksDb(db, staleOfficer, { lockId: "all", at: now, rng: () => 0.9 });
    expect(rotated.outcome).toBe("not-permitted");
  });

  it("a kicked actor's stale VaultActor gets not-visible on revealLock, not the code", async () => {
    const memberLock = (await addLockDb(db, actor("O1"), { name: "Front gate", note: null, minRole: "member", at: now, rng: () => 0.5 })).lockId!;
    const staleMember = actor("M1"); // built before the kick below

    expect(await kickDb(db, now, D.L, D.M1)).toBe("ok");

    const revealed = await revealLockDb(db, staleMember, { lockId: memberLock, at: now });
    expect(revealed).toEqual({ outcome: "not-visible", code: null });
  });
});
