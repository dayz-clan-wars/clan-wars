/**
 * One-off: give the factions that already exist their founding history, so
 * the feed's first run reads as a record rather than starting mid-story.
 *
 * ⚠️ A deliberate deploy step, never called at startup. The least controlled
 * moment to bulk-insert into production is the moment a process happens to
 * boot — the same rule, and the same reasoning, as `runMigrations`.
 *
 * ⚠️ It can only synthesize what the columns still hold. Renames, rebinds and
 * dormancy episodes that already happened are unrecoverable: the columns that
 * recorded them are overwritten or nulled by design. What this produces is a
 * founding record, not a complete one.
 *
 * Usage:
 *   set -a && . .env && set +a && npx tsx apps/bot/src/feed-backfill.ts
 */
import { createClient, factions, factionEvents, type Database } from "@factions/db";
import { asc, sql } from "drizzle-orm";

export async function backfillFactionEvents(db: Database): Promise<{ inserted: number; skipped: number }> {
  const rows = await db.select({
    id: factions.id, serverId: factions.serverId,
    name: factions.name, tag: factions.tag, texture: factions.texture,
    createdAt: factions.createdAt, activatedAt: factions.activatedAt,
  }).from(factions).orderBy(asc(factions.id));

  let inserted = 0;
  let skipped = 0;

  for (const f of rows) {
    // ⚠️ Idempotent per faction, not per row. Run twice by accident during a
    // deploy and every founding is announced a second time — to a public
    // channel, where it cannot be taken back.
    const existing = await db.select({ n: sql<number>`count(*)::int` })
      .from(factionEvents).where(sql`${factionEvents.factionId} = ${f.id}`);
    if ((existing[0]?.n ?? 0) > 0) { skipped++; continue; }

    // ⚠️ No actor. The founder's identity is not on the factions row, and
    // resolving `leader_discord_id` would name whoever holds the seat TODAY
    // as the person who founded it — which for a faction that has since
    // transferred leadership is simply false.
    const payload = { name: f.name, tag: f.tag, texture: f.texture };

    await db.insert(factionEvents).values({
      serverId: f.serverId, factionId: f.id, kind: "founded",
      occurredAt: f.createdAt, payload,
    });
    inserted++;

    if (f.activatedAt) {
      await db.insert(factionEvents).values({
        serverId: f.serverId, factionId: f.id, kind: "activated",
        occurredAt: f.activatedAt, payload,
      });
      inserted++;
    }
  }

  return { inserted, skipped };
}

// Only when run directly, so the test can import the function.
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const result = await backfillFactionEvents(createClient(url));
  console.log(`backfill: inserted ${result.inserted} event(s), skipped ${result.skipped} faction(s)`);
  process.exit(0);
}
