import { factions, declarations, poles, events, admFiles, seasons, type Database } from "@factions/db";
import { NEW_POLE_GRACE_MS } from "@factions/domain";

export type SeedFactionArgs = {
  serverId: number; tag: string; texture: string; status?: string;
  /**
   * Defaults to the tag. Given explicitly by the tests that assert a clan's
   * NAME travels somewhere its tag does not — the feed payloads, chiefly —
   * which a name/tag collapse would silently stop covering.
   */
  name?: string;
  poleKey?: string; x?: number; y?: number; z?: number;
  leaderDiscordId?: string; createdAt: Date; activatedAt?: Date | null; dormantSince?: Date | null;
  reservedUntil?: Date | null; ceremonyId?: number | null; renamedAt?: Date | null; reboundAt?: Date | null;
};

/**
 * Insert a faction AND its declaration, the way the schema now requires.
 * Evidence is a synthetic flag.raised event at the pole, so every seeded
 * faction is one the log could have produced.
 *
 * ⚠️ This writes the declaration DIRECTLY, bypassing `declareTx`. That means
 * the 200 m separation from the Hub and from other declarations is NOT
 * checked here — only `declarations_pole_uniq` is. Two seeded clans in one
 * test therefore need distinct pole keys, and anything that must exercise the
 * distance rule has to go through `declareTx`/`reserve`/`rebind` instead.
 */
export async function seedFaction(db: Database, a: SeedFactionArgs) {
  // ⚠️ Default well clear of the Hub at (100, 93): the old (1, 2, 3) default
  // was ~134 m from it, inside the 200 m exclusion zone, so a fixture seeded
  // at the default described a base `declareTx` would refuse to create. The
  // seed bypasses declareTx, so nothing errored — the fixture was simply
  // impossible, and any test that later fed it through the real path would
  // have been testing a state the game cannot reach.
  const poleKey = a.poleKey ?? "5000.00:100.00:5000.00";
  const [x, y, z] = [a.x ?? 5000, a.y ?? 100, a.z ?? 5000];
  const [f] = await db.insert(factions).values({
    serverId: a.serverId, name: a.name ?? a.tag, tag: a.tag, texture: a.texture,
    status: a.status ?? "active", leaderDiscordId: a.leaderDiscordId ?? "d1",
    createdAt: a.createdAt, activatedAt: a.activatedAt ?? null, dormantSince: a.dormantSince ?? null,
    reservedUntil: a.reservedUntil ?? null, ceremonyId: a.ceremonyId ?? null,
    renamedAt: a.renamedAt ?? null, reboundAt: a.reboundAt ?? null,
  }).returning();
  const [adm] = await db.insert(admFiles).values({
    serverId: a.serverId, filename: `seed-${f!.id}.ADM`, bootAt: a.createdAt, linesIngested: 0, complete: true,
  }).returning();
  const [ev] = await db.insert(events).values({
    serverId: a.serverId, admFileId: adm!.id, lineIndex: 0, type: "flag.raised", occurredAt: a.createdAt,
    payload: { dayzId: "SEED", gamertag: "seed", texture: a.texture, poleKey, pole: { x, y, z } },
  }).returning();
  await db.insert(poles).values({
    serverId: a.serverId, map: "livonia", poleKey, x: x.toFixed(2), y: y.toFixed(2), z: z.toFixed(2),
    currentTexture: a.texture, flagRaised: true, firstSeenAt: a.createdAt, lastSeenAt: a.createdAt,
    graceUntil: new Date(a.createdAt.getTime() + NEW_POLE_GRACE_MS),
  }).onConflictDoNothing();
  await db.insert(declarations).values({
    serverId: a.serverId, poleKey, x: x.toFixed(2), y: y.toFixed(2), z: z.toFixed(2),
    ownerFactionId: f!.id, evidenceEventId: ev!.id, declaredAt: a.createdAt,
  });
  return f!;
}

/** The one open season on a server. Number is always 1 — nothing here exercises a wipe rollover. */
export async function seedSeason(db: Database, serverId: number, startedAt: Date) {
  const [s] = await db.insert(seasons).values({ serverId, number: 1, startedAt }).returning();
  return s!;
}
