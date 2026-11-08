import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factionMembers, events, admFiles, poles, seasonStandings, clanNotices, publicBaseBounties,
  type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { PUBLIC_BASE_BOUNTY_POINTS, scoringWeekStartOf } from "@factions/domain";
import { publicBountyTick, PUBLIC_BOUNTY_CONSUMER } from "../src/public-bounty-tick.js";
import { rebuildStandings, weekTopThree } from "../src/standings.js";
import { seedFaction, seedSeason } from "./seed.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-11-12T12:00:00Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(now.getTime() - ms);

describe("publicBountyTick", () => {
  let db: Database;
  let serverId = 0;
  let admFileId = 0;
  let seasonId = 0;
  let lineIndex = 0;
  let BEAR = 0;
  let WOLF = 0;
  const B1 = "B1-DAYZID-0000000000000000000000000";
  const W1 = "W1-DAYZID-0000000000000000000000000";
  const SOLO = "S1-DAYZID-0000000000000000000000000";
  const PUB = "8000.00:100.00:8000.00";
  const FRESH = "9000.00:100.00:9000.00";

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table public_base_bounties, clan_notices, season_standings, raids, seasons, faction_members, declarations, poles, consumer_cursors, events, adm_files, factions, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: ago(30 * DAY), linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    lineIndex = 0;
    seasonId = (await seedSeason(db, serverId, ago(30 * DAY))).id;
    BEAR = (await seedFaction(db, { serverId, tag: "BEAR", texture: "Flag_Bear", poleKey: "2000.00:100.00:2000.00", x: 2000, z: 2000, createdAt: ago(30 * DAY), activatedAt: ago(30 * DAY) })).id;
    WOLF = (await seedFaction(db, { serverId, tag: "WOLF", texture: "Flag_Wolf", poleKey: "3000.00:100.00:3000.00", x: 3000, z: 3000, createdAt: ago(30 * DAY), activatedAt: ago(30 * DAY) })).id;
    await db.insert(factionMembers).values([
      { factionId: BEAR, serverId, dayzId: B1, discordId: "dB1", role: "leader", joinedAt: ago(30 * DAY), status: "full" },
      { factionId: WOLF, serverId, dayzId: W1, discordId: "dW1", role: "leader", joinedAt: ago(30 * DAY), status: "full" },
    ]);
    // A public base: undeclared, its grace long over, flag raised 2 days ago.
    await db.insert(poles).values({
      serverId, map: "livonia", poleKey: PUB, x: "8000.00", y: "100.00", z: "8000.00",
      currentTexture: "Flag_White", flagRaised: true, firstSeenAt: ago(20 * DAY), lastSeenAt: ago(2 * DAY), graceUntil: ago(10 * DAY),
    });
    // A pole still in its grace: not public.
    await db.insert(poles).values({
      serverId, map: "livonia", poleKey: FRESH, x: "9000.00", y: "100.00", z: "9000.00",
      currentTexture: "Flag_White", flagRaised: true, firstSeenAt: ago(DAY), lastSeenAt: ago(DAY), graceUntil: new Date(now.getTime() + DAY),
    });
    await flag("raised", SOLO, PUB, ago(2 * DAY));
    await flag("raised", SOLO, FRESH, ago(DAY));
    // Seeded cursor, the way a deployed tick sits after its first (seeding) run.
    const rows = (await db.execute(sql`select coalesce(max(id), 0)::int as n from events`)) as unknown as { n: number }[];
    await db.execute(sql`insert into consumer_cursors (consumer_name, last_event_id, updated_at) values (${PUBLIC_BOUNTY_CONSUMER}, ${rows[0]!.n}, now())`);
  });

  const flag = (action: "raised" | "lowered", dayzId: string, poleKey: string, at: Date) =>
    db.insert(events).values({
      serverId, admFileId, lineIndex: lineIndex++, type: `flag.${action}`, occurredAt: at,
      payload: { dayzId, gamertag: dayzId.slice(0, 2), texture: "Flag_White", poleKey, pole: { x: 8000, y: 100, z: 8000 } },
    });
  const pointsOf = async (factionId: number) =>
    (await db.select({ p: seasonStandings.points }).from(seasonStandings).where(eq(seasonStandings.factionId, factionId)))[0]?.p ?? 0;

  it("pays a clan +50 for lowering a public base's flag, with a notice and a ledger row", async () => {
    await flag("lowered", B1, PUB, now);
    expect(await publicBountyTick(db)).toMatchObject({ claimed: 1, penalties: 0 });
    expect(await pointsOf(BEAR)).toBe(PUBLIC_BASE_BOUNTY_POINTS);
    const [n] = await db.select({ kind: clanNotices.kind, f: clanNotices.factionId, p: clanNotices.payload }).from(clanNotices);
    expect(n).toMatchObject({ kind: "public_bounty", f: BEAR, p: { points: PUBLIC_BASE_BOUNTY_POINTS } });
    const [row] = await db.select().from(publicBaseBounties);
    expect(row).toMatchObject({ kind: "claimed", points: PUBLIC_BASE_BOUNTY_POINTS, factionId: BEAR, weekStart: scoringWeekStartOf(now) });
  });

  it("⚠️ pays a clan only ONCE per public base; another clan still gets its own", async () => {
    await flag("lowered", B1, PUB, now);
    await flag("raised", SOLO, PUB, new Date(now.getTime() + 60_000));
    await flag("lowered", B1, PUB, new Date(now.getTime() + 120_000));
    await flag("raised", SOLO, PUB, new Date(now.getTime() + 180_000));
    await flag("lowered", W1, PUB, new Date(now.getTime() + 240_000));
    expect(await publicBountyTick(db)).toMatchObject({ claimed: 2 });
    expect(await pointsOf(BEAR)).toBe(PUBLIC_BASE_BOUNTY_POINTS);
    expect(await pointsOf(WOLF)).toBe(PUBLIC_BASE_BOUNTY_POINTS);
  });

  it("charges a clan −50 for EVERY raise of a flag on a public base", async () => {
    await flag("lowered", SOLO, PUB, now);
    await flag("raised", B1, PUB, new Date(now.getTime() + 60_000));
    await flag("lowered", SOLO, PUB, new Date(now.getTime() + 120_000));
    await flag("raised", B1, PUB, new Date(now.getTime() + 180_000));
    expect(await publicBountyTick(db)).toMatchObject({ penalties: 2 });
    expect(await pointsOf(BEAR)).toBe(-2 * PUBLIC_BASE_BOUNTY_POINTS);
  });

  it("ignores a pole still in its grace, a solo player, and a base whose flag went up too long ago to still be on the map", async () => {
    await flag("lowered", B1, FRESH, now);
    await flag("lowered", SOLO, PUB, now);
    await flag("raised", SOLO, PUB, new Date(now.getTime() + 1000));
    // Raised, then nobody raises it for longer than the despawn window: gone.
    await flag("lowered", B1, PUB, new Date(now.getTime() + 8 * DAY));
    expect(await publicBountyTick(db)).toMatchObject({ claimed: 0, penalties: 0 });
    expect(await db.select().from(publicBaseBounties)).toEqual([]);
  });

  it("a dormant clan pays the penalty but earns no bounty", async () => {
    await db.execute(sql`update factions set status = 'dormant', dormant_since = now() where id = ${BEAR}`);
    await flag("lowered", B1, PUB, now);
    await flag("raised", B1, PUB, new Date(now.getTime() + 1000));
    expect(await publicBountyTick(db)).toMatchObject({ claimed: 0, penalties: 1 });
  });

  it("⚠️ seeds at the log head on first run and pays nothing retroactively", async () => {
    await db.execute(sql`delete from consumer_cursors where consumer_name = ${PUBLIC_BOUNTY_CONSUMER}`);
    await flag("lowered", B1, PUB, now);
    expect(await publicBountyTick(db)).toMatchObject({ claimed: 0 });
    expect(await publicBountyTick(db)).toMatchObject({ claimed: 0 });
    expect(await db.select().from(publicBaseBounties)).toEqual([]);
  });

  it("counts toward the weekly Alpha ranking and survives a standings rebuild", async () => {
    await flag("lowered", B1, PUB, now);
    await publicBountyTick(db);
    const top = await weekTopThree(db, seasonId, scoringWeekStartOf(now));
    expect(top.map((t) => [t.factionId, t.points])).toEqual([[BEAR, PUBLIC_BASE_BOUNTY_POINTS]]);
    await rebuildStandings(db, seasonId);
    expect(await pointsOf(BEAR)).toBe(PUBLIC_BASE_BOUNTY_POINTS);
  });
});
