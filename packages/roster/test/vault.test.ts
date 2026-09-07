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

  /**
   * §4.5: "a pending member … sees no vault". Their ROLE is 'member', so an
   * ungated `exposeLocksTx` would burn every member-rank lock in the clan
   * the moment they are kicked — telling a clan to change codes that never
   * left it. Both departure paths are checked: kick, and the guild-removal
   * path, which shares the rule.
   */
  it("exposure: a PENDING member who goes exposes nothing", async () => {
    const memberLock = (await addLockDb(db, actor("O1"), { name: "Front gate", note: null, minRole: "member", at: now, rng: () => 0.5 })).lockId!;
    const officerLock = (await addLockDb(db, actor("O1"), { name: "Officer safe", note: null, minRole: "officer", at: now, rng: () => 0.1 })).lockId!;

    const pendingUid = "P".repeat(40);
    await db.insert(players).values({ dayzId: pendingUid, gamertag: "Pia", firstSeenAt: now, lastSeenAt: now });
    await db.insert(identityLinks).values({ discordId: "dP", dayzId: pendingUid, gamertag: "Pia", verifiedAt: now });
    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: pendingUid, discordId: "dP", role: "member",
      joinedAt: now, status: "pending", pendingSince: now,
    });

    expect(await kickDb(db, now, D.L, "dP")).toBe("ok");
    expect(await db.select().from(factionMembers).where(eq(factionMembers.discordId, "dP"))).toEqual([]);
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

  // ------------------------------------------------- 8. cross-clan isolation

  /**
   * Every vault read and write is scoped by `factionId` as well as `lockId`,
   * so a member of another clan naming clan A's lock id sees exactly what
   * they would see naming a lock id that never existed: `gone`, and never a
   * code. The actor here is an OFFICER of clan B, so the officer gate cannot
   * be what refuses them — only the scoping.
   */
  it("a member of another clan gets gone for clan A's lock id, and no code", async () => {
    const lockId = (await addLockDb(db, actor("O1"), { name: "Front gate", note: null, minRole: "member", at: now, rng: () => 0.5 })).lockId!;

    const [s2] = await db.insert(servers).values({ name: "S2", map: "livonia", clockOffsetMs: 0 }).returning();
    await db.insert(admFiles).values({ serverId: s2!.id, filename: "g.ADM", bootAt: now, linesIngested: 0, complete: true });
    const bUid = "B".repeat(40);
    await db.insert(players).values({ dayzId: bUid, gamertag: "Bo", firstSeenAt: now, lastSeenAt: now });
    await db.insert(identityLinks).values({ discordId: "dB", dayzId: bUid, gamertag: "Bo", verifiedAt: now });
    const other = await seedFaction(db, {
      serverId: s2!.id, tag: "WOLF", name: "Wolves", texture: "Flag_Wolf",
      leaderDiscordId: "dB", createdAt: now, activatedAt: now, poleKey: "7000.00:100.00:7000.00", x: 7000, z: 7000,
    });
    await db.insert(factionMembers).values({
      factionId: other.id, serverId: s2!.id, dayzId: bUid, discordId: "dB", role: "officer", joinedAt: now, status: "full",
    });
    const bActor: VaultActor = { factionId: other.id, serverId: s2!.id, dayzId: bUid, discordId: "dB", role: "officer" };

    const revealed = await revealLockDb(db, bActor, { lockId, at: now });
    expect(revealed).toEqual({ outcome: "gone", code: null });
    expect(await editLockDb(db, bActor, { lockId, name: "Theirs", note: null, minRole: "member", at: now })).toBe("gone");
    expect(await deleteLockDb(db, bActor, { lockId, at: now })).toBe("gone");

    // Untouched, and no history written against either clan.
    const row = await lockRow(lockId);
    expect(row.name).toBe("Front gate");
    expect((await historyRows()).map((h) => h.action)).toEqual(["added"]);
  });

  // ------------------------------------------------- 9. staged race (§13)

  /**
   * `rotateLocksDb("all")` and `leaveDb` both open by taking the clan's
   * `factions` row, so a third connection HOLDING that row parks both and
   * releasing it lets Postgres pick the order. Ordering is read out of
   * `pg_stat_activity`, never waited out — the pattern removal.test.ts uses.
   *
   * The two legal outcomes are the two halves of one rule: the leaver
   * exposes only what they knew. Leave-first, the exposure lands on the
   * PRE-rotation codes and the rotation then clears `exposed_at` — those
   * codes are dead. Rotate-first, the leaver was still in the clan when the
   * new codes were written (they were DM'd), so they knew them and the
   * exposure that follows is correct. What must never happen is the middle:
   * a lock rotated by this rotation and left exposed by an exposure the
   * rotation should have cleared, or a rotation that missed a lock. The
   * officer lock is never exposed by a plain member in either order.
   */
  for (const rotateFirst of [true, false]) {
  it(`rotate-all racing a member's leave never leaves a half-exposed vault (${rotateFirst ? "rotate" : "leave"} started first)`, async () => {
    const memberLock = (await addLockDb(db, actor("O1"), { name: "Front gate", note: null, minRole: "member", at: now, rng: () => 0.5 })).lockId!;
    const officerLock = (await addLockDb(db, actor("O1"), { name: "Officer safe", note: null, minRole: "officer", at: now, rng: () => 0.1 })).lockId!;
    const before = [(await lockRow(memberLock)).code, (await lockRow(officerLock)).code];

    const rotateAt = new Date(now.getTime() + 60_000);
    const leaveAt = new Date(now.getTime() + 30_000);

    const holderDb = createClient(URL);
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let taken!: () => void;
    const isTaken = new Promise<void>((r) => { taken = r; });
    const holder = holderDb.transaction(async (tx) => {
      await tx.execute(sql`select id from factions where id = ${factionId}::bigint for update`);
      taken();
      await released;
    });

    const dbA = createClient(URL);
    const dbB = createClient(URL);
    let rotated!: { outcome: string; rotated: number };
    let left!: string;
    try {
      await isTaken;
      // ⚠️ Staged, not just launched: each side is started only once the
      // previous one is CONFIRMED waiting on the row, so Postgres' FIFO
      // queue puts them in the order this test names. Merely calling them in
      // order proves nothing — `leaveDb` opens with an unlocked read and
      // would always queue second whichever way round the calls were
      // written. Waiter counts come from `pg_stat_activity`, never a sleep.
      const rotating = () => rotateLocksDb(dbA, actor("O1"), { lockId: "all", at: rotateAt, rng: () => 0.9 });
      const leaving = () => leaveDb(dbB, leaveAt, D.M1);
      const waitFor = async (n: number) => {
        for (let i = 0; i < 20_000; i++) {
          const rows = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
          if (Number((rows as unknown as { n: number }[])[0]!.n) >= n) return;
        }
        throw new Error(`only saw fewer than ${n} waiters on the factions row`);
      };

      let rotateP: ReturnType<typeof rotating>;
      let leaveP: ReturnType<typeof leaving>;
      if (rotateFirst) {
        rotateP = rotating();
        await waitFor(1);
        leaveP = leaving();
      } else {
        leaveP = leaving();
        await waitFor(1);
        rotateP = rotating();
      }
      await waitFor(2);
      const racers = Promise.all([rotateP, leaveP]);
      release();
      [rotated, left] = await racers;
    } finally {
      release();
      await holder.catch(() => {});
      await holderDb.$client.end();
      await dbA.$client.end();
      await dbB.$client.end();
    }

    // Neither order may error; both wrote what they promised.
    expect(rotated).toEqual({ outcome: "ok", rotated: 2 });
    expect(left).toBe("ok");
    expect(await db.select().from(factionMembers).where(eq(factionMembers.discordId, D.M1))).toEqual([]);

    const after = [await lockRow(memberLock), await lockRow(officerLock)];
    // The rotation covered the WHOLE vault, whichever side went first.
    expect(after[0]!.code).not.toBe(before[0]);
    expect(after[1]!.code).not.toBe(before[1]);
    expect(after[0]!.rotatedAt?.getTime()).toBe(rotateAt.getTime());
    expect(after[1]!.rotatedAt?.getTime()).toBe(rotateAt.getTime());

    // A member leaver never exposes an officer-only lock, in either order.
    expect(after[1]!.exposedAt).toBeNull();

    // And the member lock is in exactly one of the two consistent states:
    // cleared by the rotation (leave went first), or exposed at the leave's
    // own timestamp because the leaver was still in the clan when the new
    // code was written. Never anything between.
    const exposed = after[0]!.exposedAt;
    expect(exposed === null || exposed.getTime() === leaveAt.getTime()).toBe(true);
  });
  }

  it("a kicked actor's stale VaultActor gets not-visible on revealLock, not the code", async () => {
    const memberLock = (await addLockDb(db, actor("O1"), { name: "Front gate", note: null, minRole: "member", at: now, rng: () => 0.5 })).lockId!;
    const staleMember = actor("M1"); // built before the kick below

    expect(await kickDb(db, now, D.L, D.M1)).toBe("ok");

    const revealed = await revealLockDb(db, staleMember, { lockId: memberLock, at: now });
    expect(revealed).toEqual({ outcome: "not-visible", code: null });
  });
});
