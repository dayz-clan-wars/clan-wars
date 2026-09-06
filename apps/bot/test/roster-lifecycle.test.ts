import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, rosterCooldowns,
  declarations, poles, events, admFiles,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { RELEASED_POLE_GRACE_MS } from "@factions/domain";
import { PgRosterStore, identityTakenTx, type RenameArgs } from "@factions/roster/internal";
import { seedFaction } from "./seed.js";

const URL = requireTestDatabaseUrl();
const LEADER = "d1";
const t0 = new Date("2026-08-31T12:00:00Z");
const RENAME_COOLDOWN_MS = 604_800_000; // 7 days
const past = new Date(t0.getTime() - RENAME_COOLDOWN_MS - 1);
const POLE = "1:2:3";

describe("PgRosterStore disband and rename", () => {
  let db: Database;
  let store: PgRosterStore;
  let serverId = 0;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // SET LOCAL shares the truncate's connection (the pool hands out any
    // connection, and the setting reverts at commit), so the dozens of
    // "truncate cascades to ..." NOTICEs stay out of the suite's output and a
    // genuine warning is visible when one appears.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table faction_invites, roster_cooldowns, declarations, poles, faction_members, factions, events, raw_lines, adm_files, identity_links, servers restart identity cascade`);
    });
    store = new PgRosterStore(db);

    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear",
      status: "active", leaderDiscordId: LEADER, createdAt: t0,
    }).returning();
    factionId = f!.id;
    await db.insert(factionMembers).values([
      { factionId, serverId, dayzId: "L".repeat(40), discordId: LEADER, role: "leader", joinedAt: t0 },
      { factionId, serverId, dayzId: "M".repeat(40), discordId: "d3", role: "member", joinedAt: t0 },
    ]);

    // Task 9's shared seed helper doesn't exist yet, so this is a minimal
    // local declaration: the faction's hold on POLE now lives in
    // `declarations` (the schema dropped factions.poleKey/x/y/z), and
    // disband's releaseTx depends on finding it there.
    const [admFile] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: t0 }).returning();
    const [evidence] = await db.insert(events).values({
      serverId, admFileId: admFile!.id, lineIndex: 0, type: "flag.raised",
      occurredAt: t0, payload: {},
    }).returning();
    await db.insert(declarations).values({
      serverId, poleKey: POLE, x: "1.00", y: "2.00", z: "3.00",
      ownerFactionId: factionId, evidenceEventId: evidence!.id, declaredAt: t0,
    });
  });

  describe("disband", () => {
    it("refuses a non-leader", async () => {
      const r = await store.disband(factionId, "d3");
      expect(r).toBe("not-leader");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.status).toBe("active");
    });

    it("disbanding releases flag, tag, pole and roster", async () => {
      // The pole itself: disbandFactionTx's releaseTx call is what starts its
      // 3-day grace, and that write is the assertion below.
      const [pole] = await db.insert(poles).values({
        serverId, map: "sakhal", poleKey: POLE, x: "1.00", y: "2.00", z: "3.00",
        currentTexture: "Flag_Bear", flagRaised: true,
        firstSeenAt: t0, lastSeenAt: t0, graceUntil: t0,
      }).returning();

      expect(await store.disband(factionId, LEADER)).toBe("ok");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.status).toBe("disbanded");
      expect(await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId))).toEqual([]);

      // The declaration is gone — disband released the pole, not just froze it.
      expect(await db.select().from(declarations)
        .where(eq(declarations.ownerFactionId, factionId))).toEqual([]);

      // And the pole's grace was stamped to (disband's `new Date()`) + the
      // released-pole grace window — checked within a few seconds since
      // disband stamps its own `new Date()`, not `t0`.
      const [after] = await db.select().from(poles).where(eq(poles.id, pole!.id));
      const expectedGrace = Date.now() + RELEASED_POLE_GRACE_MS;
      expect(Math.abs(after!.graceUntil.getTime() - expectedGrace)).toBeLessThan(5000);

      // The releasing indexes are partial over the holding statuses, so the
      // texture is immediately re-claimable by someone else.
      await db.insert(factions).values({
        serverId, name: "Bears II", tag: "BEAR", texture: "Flag_Bear",
        status: "active", leaderDiscordId: "d9", createdAt: t0,
      });
    });

    it("disbanding writes no cooldowns", async () => {
      await store.disband(factionId, LEADER);
      expect(await db.select().from(rosterCooldowns)).toEqual([]);
    });

    it("disband holds the name and tag until season end; a new claim on either is refused", async () => {
      expect(await store.disband(factionId, LEADER)).toBe("ok");
      const holds = await db.execute(sql`select kind, value_lower, reason, held_until = 'infinity' as forever from identity_holds order by kind`);
      expect(holds).toEqual([
        { kind: "name", value_lower: "bears", reason: "disbanded", forever: true },
        { kind: "tag", value_lower: "bear", reason: "disbanded", forever: true },
      ]);
      // The same identity, sought by a fresh claim — the tag is the check that fires first.
      expect(await db.transaction((tx) => identityTakenTx(tx, { serverId, name: "Bears", tag: "BEAR" }))).toBe("name-held");
      expect(await db.transaction((tx) => identityTakenTx(tx, { serverId, name: "Wolves", tag: "bear" }))).toBe("tag-held");
      expect(await db.transaction((tx) => identityTakenTx(tx, { serverId, name: "Wolves", tag: "WOLF" }))).toBeNull();
    });
  });

  /**
   * Leadership authority must follow the `faction_members` roster row, which
   * `faction_members_leader_uniq` protects, and never the denormalised
   * `factions.leader_discord_id` copy. Every other suite in this plan seeds
   * the two in agreement and never transfers, so a guard reading the stale
   * copy looked correct everywhere. These tests transfer first.
   */
  describe("after a leadership transfer", () => {
    const NEW_LEADER = "d3";

    beforeEach(async () => {
      expect(await store.transfer({ factionId, fromDiscordId: LEADER, toDiscordId: NEW_LEADER, at: t0 })).toBe("ok");
    });

    it("names the new leader on the faction row", async () => {
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.leaderDiscordId).toBe(NEW_LEADER);
    });

    it("lets the new leader rename", async () => {
      const r = await store.rename({ factionId, discordId: NEW_LEADER, name: "Cubs", at: t0, notBefore: past });
      expect(r).toBe("ok");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.name).toBe("Cubs");
    });

    it("lets the new leader disband", async () => {
      expect(await store.disband(factionId, NEW_LEADER)).toBe("ok");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.status).toBe("disbanded");
    });

    it("refuses the demoted old leader's rename", async () => {
      const r = await store.rename({ factionId, discordId: LEADER, name: "Cubs", at: t0, notBefore: past });
      expect(r).toBe("not-leader");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.name).toBe("Bears");
    });

    it("refuses the demoted old leader's disband", async () => {
      expect(await store.disband(factionId, LEADER)).toBe("not-leader");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.status).toBe("active");
      expect(await db.select().from(factionMembers).where(eq(factionMembers.factionId, factionId))).toHaveLength(2);
    });
  });

  describe("rename", () => {
    const renameArgs = (over: Partial<RenameArgs> = {}): RenameArgs => ({
      factionId, discordId: LEADER, name: "Second", at: t0, notBefore: past,
      ...over,
    });

    it("refuses a non-leader", async () => {
      const r = await store.rename(renameArgs({ discordId: "d3" }));
      expect(r).toBe("not-leader");
    });

    it("a first rename is always allowed", async () => {
      const r = await store.rename(renameArgs({ name: "First" }));
      expect(r).toBe("ok");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.name).toBe("First");
      expect(f!.renamedAt).not.toBeNull();
    });

    it("a rename inside the cooldown is refused and changes nothing", async () => {
      const t1 = new Date(t0.getTime() + 60_000);
      const t1MinusSixDays = new Date(t1.getTime() - 6 * 24 * 60 * 60 * 1000);
      const ok1 = await store.rename({ factionId, discordId: LEADER, name: "First", at: t0, notBefore: past });
      expect(ok1).toBe("ok");
      const r = await store.rename({ factionId, discordId: LEADER, name: "Second", at: t1, notBefore: t1MinusSixDays });
      expect(r).toBe("cooldown");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.name).toBe("First");
    });

    it("a rename after the cooldown has elapsed is allowed", async () => {
      const t1 = new Date(t0.getTime() + RENAME_COOLDOWN_MS + 60_000);
      const notBefore = new Date(t1.getTime() - RENAME_COOLDOWN_MS);
      await store.rename({ factionId, discordId: LEADER, name: "First", at: t0, notBefore: past });
      const r = await store.rename({ factionId, discordId: LEADER, name: "Second", at: t1, notBefore });
      expect(r).toBe("ok");
      const [f] = await db.select().from(factions).where(eq(factions.id, factionId));
      expect(f!.name).toBe("Second");
    });

    it("rename holds the OLD name (and old tag when it changes) and refuses a held or taken identity", async () => {
      expect(await store.rename({ factionId, discordId: LEADER, name: "Grizzlies", tag: "GRIZ", at: t0, notBefore: past })).toBe("ok");
      const holds = await db.execute(sql`select kind, value_lower, reason from identity_holds order by kind`);
      expect(holds).toEqual([{ kind: "name", value_lower: "bears", reason: "renamed" }, { kind: "tag", value_lower: "bear", reason: "renamed" }]);
      // Renaming back to the held name is refused — even for the clan that held it? No: exceptFactionId frees your own holds.
      await db.update(factions).set({ renamedAt: null }).where(eq(factions.id, factionId));
      expect(await store.rename({ factionId, discordId: LEADER, name: "Bears", at: t0, notBefore: past })).toBe("ok");
    });

    it("a name-only rename holds only the old name, not the unchanged tag", async () => {
      expect(await store.rename({ factionId, discordId: LEADER, name: "Grizzlies", at: t0, notBefore: past })).toBe("ok");
      const holds = await db.execute(sql`select kind, value_lower, reason from identity_holds order by kind`);
      expect(holds).toEqual([{ kind: "name", value_lower: "bears", reason: "renamed" }]);
    });

    it("a tag-only rename holds only the old tag, not the unchanged name", async () => {
      expect(await store.rename({ factionId, discordId: LEADER, name: "Bears", tag: "GRIZ", at: t0, notBefore: past })).toBe("ok");
      const holds = await db.execute(sql`select kind, value_lower, reason from identity_holds order by kind`);
      expect(holds).toEqual([{ kind: "tag", value_lower: "bear", reason: "renamed" }]);
    });

    it("rename refuses another holding clan's name or tag", async () => {
      await seedFaction(db, { serverId, tag: "WOLF", name: "Wolves", texture: "Flag_Wolf", createdAt: t0, poleKey: "9000.00:100.00:9000.00", x: 9000, z: 9000 });
      expect(await store.rename({ factionId, discordId: LEADER, name: "wolves", at: t0, notBefore: past })).toBe("name-taken");
      expect(await store.rename({ factionId, discordId: LEADER, name: "Bears2", tag: "wolf", at: t0, notBefore: past })).toBe("tag-taken");
    });
  });
});
