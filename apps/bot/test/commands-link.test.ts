import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, identityLinks, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { makeRoster } from "@factions/roster";
import { SPECS } from "../src/commands/index.js";
import type { Ctx, CommandInput } from "../src/commands/types.js";

const URL = requireTestDatabaseUrl();
const NOW = new Date("2026-09-13T12:00:00Z");
const D = "discord-ada";
const UID = "A".repeat(40);

const noOptions: Omit<CommandInput, "actorDiscordId"> = {
  string: () => null, integer: () => null, boolean: () => null, user: () => null,
};
const input = (actorDiscordId: string, over: Partial<CommandInput> = {}): CommandInput =>
  ({ actorDiscordId, ...noOptions, ...over });

describe("/link status", () => {
  let db: Database;
  let ctx: Ctx;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table identity_links, verification_challenges, players, servers restart identity cascade`);
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 });
    ctx = { roster: makeRoster(() => db, () => NOW), now: NOW, siteBaseUrl: "https://example.test" };
  });

  const run = (i: CommandInput) => SPECS.get("link status")!.handler(ctx, i);

  it("tells an unlinked player how to start", async () => {
    const reply = await run(input(D));
    expect(reply.ephemeral).toBe(true);
    const embed = reply.embeds![0]!.toJSON();
    expect(embed.description).toContain("/link start");
  });

  it("shows the linked character", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const reply = await run(input(D));
    const embed = reply.embeds![0]!.toJSON();
    expect(JSON.stringify(embed)).toContain("Ada");
  });

  it("never says faction", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const reply = await run(input(D));
    expect(JSON.stringify(reply).toLowerCase()).not.toContain("faction");
  });
});
