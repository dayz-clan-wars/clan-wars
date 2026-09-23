import { describe, it, expect, beforeAll } from "vitest";
import { sql } from "drizzle-orm";
import {
  createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, factionMembers,
  type Database,
} from "@factions/db";
import { CLAIMABLE_FLAGS } from "@factions/domain";
import { clockQuery } from "../src/dormancy-store.js";
import { seedFaction } from "./seed.js";

// ⚠️ The derived factions_test_bot, never the raw base URL: this suite migrates
// and seeds, and the base names the shared `factions` database.
const URL = requireTestDatabaseUrl();

// The shape of a busy season on one server, scaled down from the 1M-event
// measurement below so the seed stays a second or two. What matters to the
// planner is the RATIOS — raises are a small share of events, each clan's
// raises are spread over its members, and every clan raises only at its own
// pole — not the absolute size.
const CLANS = 30; // < 33: `texture` is unique among holding clans on a server
const MEMBERS_PER_CLAN = 5;
const RAISES = 24_000;
const OTHER_EVENTS = 176_000;

/**
 * ⚠️ `events_raise_lookup_idx` and the LAST_RAISE subquery are two statements
 * of one fact: the event type `flag.raised` and the payload keys `poleKey` and
 * `texture`. Rename a key on one side and nothing errors and no answer changes
 * — the subquery just goes back to filtering every flag.raised row on the
 * server, once per faction, every tick. `guardedRunner` hides that by skipping
 * overlapping runs, so the dormancy clock would quietly stop keeping up.
 * Measured at 1M events / 120k raises / 45 factions: 352ms per tick without
 * the index, 0.4ms with it.
 *
 * Asserting the plan merely NAMES the index is not enough — `server_id` alone
 * keeps it usable, so a renamed payload key still produces an index scan. The
 * drift signature is the key moving out of `Index Cond` and into `Filter`,
 * which is what this asserts.
 *
 * ⚠️ The plan is only evidence if the planner had something to choose between.
 * This suite once ran on an empty `events` table with `enable_seqscan` and
 * `enable_bitmapscan` switched off. There every candidate index cost the same,
 * so it passed by tie-break. On a database with other suites' leftover rows
 * and statistics it picked `events_raise_by_player_idx` with no Index Cond at
 * all — every raise on the server, filtered (inbox item 44). So it seeds a
 * production-shaped table, ANALYZEs it, and explains with the planner's
 * defaults: the plan asserted is the one production would get.
 */
describe("the dormancy clock's raise lookup is index-backed", () => {
  let db: Database;
  beforeAll(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(
      sql`truncate table faction_members, factions, declarations, poles, events, adm_files, servers restart identity cascade`,
    );

    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    const serverId = s!.id;
    const createdAt = new Date("2026-01-01T00:00:00Z");
    const start = createdAt.toISOString(); // raw sql binds strings, not Dates
    for (let c = 0; c < CLANS; c++) {
      const f = await seedFaction(db, {
        serverId, tag: `C${c}`, texture: CLAIMABLE_FLAGS[c]!, createdAt,
        poleKey: `${1000 + c * 300}.00:100.00:5000.00`, x: 1000 + c * 300,
      });
      await db.insert(factionMembers).values(
        Array.from({ length: MEMBERS_PER_CLAN }, (_, m) => ({
          factionId: f.id, serverId, dayzId: `p${c}_${m}`, discordId: `d${c}_${m}`,
          role: m === 0 ? "leader" : "member", joinedAt: createdAt,
        })),
      );
    }
    const [adm] = await db.insert(admFiles).values({
      serverId, filename: "bulk.ADM", bootAt: createdAt, linesIngested: 0, complete: true,
    }).returning();

    // Raises: clan g % CLANS, one of its members, at its own pole with its own
    // texture, spread over sixty days.
    await db.execute(sql`
      insert into events (server_id, adm_file_id, line_index, type, occurred_at, payload)
      select ${serverId}, ${adm!.id}, g, 'flag.raised',
             ${start}::timestamptz + (g * interval '60 days' / ${RAISES}),
             jsonb_build_object(
               'dayzId', format('p%s_%s', clan.c, (g / ${CLANS}) % ${MEMBERS_PER_CLAN}),
               'texture', clan.texture, 'poleKey', clan.pole_key)
      from generate_series(1, ${RAISES}) g
      join (
        select row_number() over (order by f.id) - 1 as c, f.texture, d.pole_key
        from factions f join declarations d on d.owner_faction_id = f.id
      ) clan on clan.c = g % ${CLANS}
    `);
    // Everything else the log carries, by the same players.
    await db.execute(sql`
      insert into events (server_id, adm_file_id, line_index, type, occurred_at, payload)
      select ${serverId}, ${adm!.id}, ${RAISES} + g, 'player.hit',
             ${start}::timestamptz + (g * interval '60 days' / ${OTHER_EVENTS}),
             jsonb_build_object('dayzId', format('p%s_%s', g % ${CLANS}, g % ${MEMBERS_PER_CLAN}))
      from generate_series(1, ${OTHER_EVENTS}) g
    `);
    await db.execute(sql`analyze events, factions, declarations, faction_members, seasons`);
  }, 60_000);

  it("resolves both payload keys through the index, not a filter", async () => {
    const { sql: text, params } = clockQuery(db).toSQL();

    const client = (db as unknown as {
      $client: { unsafe: (q: string, p: unknown[]) => Promise<Record<string, string>[]> };
    }).$client;
    const plan = await client.unsafe(`explain ${text}`, params as unknown[]);
    const lines = plan.map((r) => r["QUERY PLAN"] as string);
    const planText = lines.join("\n");

    expect(planText).toContain("events_raise_lookup_idx");

    const indexConds = lines.filter((l) => l.includes("Index Cond:")).join("\n");
    expect(indexConds, planText).toContain("payload ->> 'poleKey'");
    expect(indexConds, planText).toContain("payload ->> 'texture'");

    // The roster predicate is allowed as a Filter — it runs after the index
    // has narrowed to one pole and one texture. poleKey and texture are not.
    const payloadFilters = lines.filter((l) => /Filter:.*payload/.test(l));
    for (const l of payloadFilters) {
      expect(l, planText).not.toContain("'poleKey'");
      expect(l, planText).not.toContain("'texture'");
    }
  });
});
