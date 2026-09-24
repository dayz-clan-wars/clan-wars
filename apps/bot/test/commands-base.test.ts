import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, identityLinks, admFiles, poles, events, players, type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { makeRoster } from "@factions/roster";
import { DECLARE_COPY } from "@factions/copy";
import { SPECS } from "../src/commands/index.js";
import type { Ctx, CommandInput } from "../src/commands/types.js";

const URL = requireTestDatabaseUrl();
const NOW = new Date("2026-09-13T12:00:00Z");
const D = "discord-ada";
const UID = "A".repeat(40);

const input = (actorDiscordId: string, over: Partial<CommandInput> = {}): CommandInput => ({
  actorDiscordId, string: () => null, integer: () => null, boolean: () => null, user: () => null, isAdmin: false, ...over,
});

describe("/base", () => {
  let db: Database;
  let ctx: Ctx;
  let serverId = 0;
  let admFileId = 0;
  let line = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table identity_links, declarations, poles, events, adm_files, clan_notices, players, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
    const [a] = await db.insert(admFiles).values({ serverId, filename: "f.ADM", bootAt: NOW, linesIngested: 0, complete: true }).returning();
    admFileId = a!.id;
    line = 0;
    ctx = { roster: makeRoster(() => db, () => NOW), now: NOW, siteBaseUrl: "https://example.test", db, serverEvents: null, bountiesEnabled: false, koth: null };
  });

  const pole = (poleKey: string, x: number, z: number) => db.insert(poles).values({
    serverId, map: "livonia", poleKey, x: x.toFixed(2), y: "100.00", z: z.toFixed(2),
    currentTexture: "Flag_White", flagRaised: true, firstSeenAt: NOW, lastSeenAt: NOW, graceUntil: NOW,
  });
  const raise = async (dayzId: string, poleKey: string, x: number, z: number, at: Date) => {
    const [e] = await db.insert(events).values({
      serverId, admFileId, lineIndex: line++, type: "flag.raised", occurredAt: at,
      payload: { dayzId, gamertag: "G", texture: "Flag_White", poleKey, pole: { x, y: 100, z } },
    }).returning({ id: events.id });
    return e!.id;
  };

  it("tells an unlinked player to link first", async () => {
    const reply = await SPECS.get("base show")!.handler(ctx, input(D));
    expect(reply.ephemeral).toBe(true);
    expect(JSON.stringify(reply)).toContain("Link your character first");
  });

  it("refuses a declare at a pole the log never saw the player raise", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const reply = await SPECS.get("base declare")!.handler(
      ctx, input(D, { string: (n) => (n === "pole" ? "9000.00:100.00:9000.00" : null) }),
    );
    expect(reply.content).toBe(DECLARE_COPY["no-raise"]);
  });

  it("says so when there was no base to release", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const reply = await SPECS.get("base release")!.handler(ctx, input(D));
    expect(reply.content).toBe("You had no declared base to release.");
  });

  it("offers only poles this player raised at", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const choices = await SPECS.get("base declare")!.autocomplete!.pole!(ctx, { actorDiscordId: D, value: "" });
    expect(choices).toEqual([]);
  });

  it("offers a pole the player actually raised at, and nothing they did not", async () => {
    await db.insert(players).values({ dayzId: UID, gamertag: "Ada", firstSeenAt: NOW, lastSeenAt: NOW });
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const P1 = "5000.00:100.00:5000.00";
    const STRANGER_POLE = "7000.00:100.00:7000.00";
    await pole(P1, 5000, 5000);
    await pole(STRANGER_POLE, 7000, 7000);
    await raise(UID, P1, 5000, 5000, NOW);
    await raise("STRANGER".padEnd(40, "0"), STRANGER_POLE, 7000, 7000, NOW);

    const choices = await SPECS.get("base declare")!.autocomplete!.pole!(ctx, { actorDiscordId: D, value: "" });
    expect(choices).toEqual([{ name: "5000, 5000", value: P1 }]);
  });

  it("caps autocomplete choices at 25, Discord's limit", async () => {
    await db.insert(players).values({ dayzId: UID, gamertag: "Ada", firstSeenAt: NOW, lastSeenAt: NOW });
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    for (let i = 0; i < 30; i++) {
      const poleKey = `${(1000 + i).toFixed(2)}:100.00:1000.00`;
      await pole(poleKey, 1000 + i, 1000);
      await raise(UID, poleKey, 1000 + i, 1000, NOW);
    }

    const choices = await SPECS.get("base declare")!.autocomplete!.pole!(ctx, { actorDiscordId: D, value: "" });
    expect(choices.length).toBe(25);
  });

  it("never says faction", async () => {
    await db.insert(identityLinks).values({ discordId: D, dayzId: UID, gamertag: "Ada", verifiedAt: NOW });
    const reply = await SPECS.get("base show")!.handler(ctx, input(D));
    expect(JSON.stringify(reply).toLowerCase()).not.toContain("faction");
  });
});
