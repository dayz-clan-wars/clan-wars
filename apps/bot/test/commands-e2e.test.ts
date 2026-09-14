import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, identityLinks, factionMembers, vaultLocks, type Database,
} from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { makeRoster } from "@factions/roster";
import { vaultGroup } from "../src/commands/vault.js";
import { specOf } from "./command-fakes.js";
import { seedFaction } from "./seed.js";

/**
 * ⚠️ The only test in `apps/bot` that runs a command against a database.
 * Every other command test stubs the roster, which proves the handler asks
 * the right question but never that the answer lands in a row — so a wiring
 * mistake between `makeRoster` and the handler (a wrong argument order, a
 * dropped field) would pass the entire suite. One command is enough to hold
 * that wire down; this is not a second copy of the vault's unit tests.
 */
describe("a slash command, end to end", () => {
  const URL = requireTestDatabaseUrl();
  const LEADER_DISCORD = "d1";
  const now = new Date("2026-09-13T12:00:00Z");
  let db: Database;
  let factionId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // SET LOCAL shares the truncate's connection (the pool hands out any
    // connection, and the setting reverts at commit), so the dozens of
    // "truncate cascades to ..." NOTICEs stay out of the suite's output and a
    // genuine warning is visible when one appears. Copied from
    // roster-store.test.ts's beforeEach, which does this correctly for the
    // same schema.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table faction_invites, roster_cooldowns, faction_members, declarations, poles, events, adm_files, factions, identity_links, servers restart identity cascade`);
    });
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    const serverId = s!.id;

    const f = await seedFaction(db, {
      serverId, name: "Wolves", tag: "WLF", texture: "Flag_Wolves",
      poleKey: "5000.00:100.00:5000.00", status: "active",
      leaderDiscordId: LEADER_DISCORD, createdAt: now,
    });
    factionId = f.id;

    await db.insert(identityLinks).values({
      discordId: LEADER_DISCORD, dayzId: "D".repeat(40), gamertag: "Leader", verifiedAt: now,
    });
    await db.insert(factionMembers).values({
      factionId, serverId, dayzId: "D".repeat(40), discordId: LEADER_DISCORD, role: "leader", joinedAt: now,
    });
  });

  it("writes the lock /vault add's modal described, and /vault list reads it back", async () => {
    const ctx = { roster: makeRoster(() => db, () => now), now, siteBaseUrl: "https://x" };

    const added = await vaultGroup.modals!["vault-add"]!(ctx, {
      actorDiscordId: LEADER_DISCORD, arg: "officer",
      field: (n: string) => ({ name: "Front gate", note: "the big one", code: "1234" })[n] ?? "",
    });
    expect(added.content).toBe("Lock added.");

    const rows = await db.select().from(vaultLocks).where(eq(vaultLocks.factionId, factionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Front gate");
    expect(rows[0]!.minRole).toBe("officer");

    const listed = await specOf(vaultGroup, "vault list").handler(ctx, {
      actorDiscordId: LEADER_DISCORD, string: () => null, integer: () => null, boolean: () => null, user: () => null,
    });
    expect(JSON.stringify(listed.embeds![0]!.toJSON())).toContain("Front gate");
    // ⚠️ And the code is nowhere in the card.
    expect(JSON.stringify(listed.embeds![0]!.toJSON())).not.toContain("1234");
  });
});
