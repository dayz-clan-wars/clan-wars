import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, identityLinks, players, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { suggestGamertagsDb, SUGGEST_LIMIT } from "../src/suggest";

const URL = requireTestDatabaseUrl();
const t0 = new Date("2026-09-05T12:00:00Z");
const at = (h: number) => new Date(t0.getTime() + h * 3_600_000);
const uid = (n: number) => String(n).padStart(40, "0");

describe("suggestGamertags", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table identity_links, players restart identity cascade`);
    });
    await db.insert(players).values([
      { dayzId: uid(1), gamertag: "Ronald", firstSeenAt: t0, lastSeenAt: at(1) },
      { dayzId: uid(2), gamertag: "ronin_99", firstSeenAt: t0, lastSeenAt: at(3) },
      { dayzId: uid(3), gamertag: "Ro%pct", firstSeenAt: t0, lastSeenAt: at(2) },
      { dayzId: uid(4), gamertag: "Hollis", firstSeenAt: t0, lastSeenAt: at(4) },
    ]);
    // Ronald linked under an older spelling; Hollis linked as-is.
    await db.insert(identityLinks).values([
      { discordId: "d1", dayzId: uid(1), gamertag: "RonaId", verifiedAt: at(1) },
      { discordId: "d4", dayzId: uid(4), gamertag: "Hollis", verifiedAt: at(2) },
    ]);
  });

  it("seen: every character the log has recorded, case-insensitive prefix, newest sighting first", async () => {
    expect(await suggestGamertagsDb(db, "ro", "seen")).toEqual(["ronin_99", "Ro%pct", "Ronald"]);
    expect(await suggestGamertagsDb(db, "RON", "seen")).toEqual(["ronin_99", "Ronald"]);
  });

  it("linked: only bound characters, under the name they were linked as", async () => {
    expect(await suggestGamertagsDb(db, "ro", "linked")).toEqual(["RonaId"]);
    expect(await suggestGamertagsDb(db, "h", "linked")).toEqual(["Hollis"]);
    expect(await suggestGamertagsDb(db, "ronin", "linked")).toEqual([]);
  });

  it("treats a typed % or _ as itself, and a blank prefix as nothing", async () => {
    expect(await suggestGamertagsDb(db, "ro%", "seen")).toEqual(["Ro%pct"]);
    expect(await suggestGamertagsDb(db, "ronin_", "seen")).toEqual(["ronin_99"]);
    expect(await suggestGamertagsDb(db, "%", "seen")).toEqual([]);
    expect(await suggestGamertagsDb(db, "   ", "seen")).toEqual([]);
  });

  it("offers a name once even when two characters carry it", async () => {
    await db.insert(players).values({ dayzId: uid(9), gamertag: "Hollis", firstSeenAt: t0, lastSeenAt: at(9) });
    expect(await suggestGamertagsDb(db, "hol", "seen")).toEqual(["Hollis"]);
  });

  it("caps the list", async () => {
    await db.insert(players).values(Array.from({ length: SUGGEST_LIMIT + 3 }, (_, i) => ({ dayzId: uid(100 + i), gamertag: `Zed${i}`, firstSeenAt: t0, lastSeenAt: t0 })));
    expect(await suggestGamertagsDb(db, "zed", "seen")).toHaveLength(SUGGEST_LIMIT);
  });
});
