import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, identityLinks, players, type Database } from "@factions/db";
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

describe("/link start", () => {
  let db: Database;
  let ctx: Ctx;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table identity_links, verification_challenges, players, servers restart identity cascade`);
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 });
    await db.insert(players).values({ dayzId: UID, gamertag: "Ada", firstSeenAt: NOW, lastSeenAt: NOW });
    ctx = { roster: makeRoster(() => db, () => NOW), now: NOW, siteBaseUrl: "https://example.test" };
  });

  const spec = () => SPECS.get("link start")!;

  it("issues a challenge and shows the sequence", async () => {
    const reply = await spec().handler(ctx, input(D, { string: (n) => (n === "character" ? UID : null) }));
    expect(reply.ephemeral).toBe(true);
    expect(JSON.stringify(reply.embeds![0]!.toJSON())).toContain("Ada");
  });

  it("refuses a character the log has never seen, in the site's words", async () => {
    const reply = await spec().handler(ctx, input(D, { string: (n) => (n === "character" ? "Z".repeat(40) : null) }));
    expect(reply.content).toBe("The server has not seen that character. Pick one from the list — only characters the event log has seen can be linked.");
  });

  it("autocompletes characters the log has seen", async () => {
    const choices = await spec().autocomplete!.character!(ctx, { actorDiscordId: D, value: "Ad" });
    expect(choices).toEqual([{ name: "Ada", value: UID }]);
  });

  it("returns no more than 25 choices", async () => {
    await db.insert(players).values(
      Array.from({ length: 40 }, (_, n) => ({ dayzId: `B${String(n).padStart(39, "0")}`, gamertag: `Ada${n}`, firstSeenAt: NOW, lastSeenAt: NOW })),
    );
    const choices = await spec().autocomplete!.character!(ctx, { actorDiscordId: D, value: "Ada" });
    expect(choices.length).toBeLessThanOrEqual(25);
  });
});

describe("/link cancel and /link unlink", () => {
  let db: Database;
  let ctx: Ctx;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table identity_links, verification_challenges, players, declarations, poles, servers restart identity cascade`);
    await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 });
    ctx = { roster: makeRoster(() => db, () => NOW), now: NOW, siteBaseUrl: "https://example.test" };
  });

  it("says so when there was nothing to cancel", async () => {
    const reply = await SPECS.get("link cancel")!.handler(ctx, input(D));
    expect(reply.content).toBe("You had no open challenge.");
    expect(reply.ephemeral).toBe(true);
  });

  it("unlinks a linked player in the site's words", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const reply = await SPECS.get("link unlink")!.handler(ctx, input(D));
    expect(reply.content).toBe("Unlinked. Your solo base, if you had one, has been released.");
  });

  it("tells a player who was never linked", async () => {
    const reply = await SPECS.get("link unlink")!.handler(ctx, input(D));
    expect(reply.content).toBe("You were not linked to a character.");
  });
});
