import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, ceremonies, ceremonyParticipants, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { formatCeremonyDm, notifyCeremonies } from "../src/ceremony-notify.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-08-31T12:00:00Z");
const expiresAt = new Date(now.getTime() + 86_400_000);

describe("ceremony notification", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table ceremony_participants, ceremonies, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "sakhal", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  const detected = async (n: number) => {
    const [c] = await db.insert(ceremonies).values({
      serverId, poleKey: "1:2:3", x: "1", y: "2", z: "3", windowStart: now, windowEnd: now,
      status: "provisional", detectedAt: now, expiresAt,
    }).returning();
    await db.insert(ceremonyParticipants).values(
      Array.from({ length: n }, (_, i) => ({
        ceremonyId: c!.id, dayzId: `${i}`.repeat(40), discordId: `10${i}`, gamertag: `P${i}`,
      })),
    );
    return c!.id;
  };

  it("states how many linked UIDs were counted", () => {
    // The only feedback available for the invisible near-miss: an unlinked
    // participant has no Discord id, so the group has to work out who is
    // missing from the count.
    const text = formatCeremonyDm({
      poleKey: "1:2:3", participants: [{ gamertag: "A" }, { gamertag: "B" }, { gamertag: "C" }], expiresAt,
    });
    expect(text).toMatch(/3 linked/i);
    expect(text).toContain("A");
    expect(text).toContain("/faction claim");
  });

  it("DMs every participant exactly once", async () => {
    await detected(3);
    const send = vi.fn().mockResolvedValue(undefined);
    expect(await notifyCeremonies(db, send, () => now)).toBe(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(await notifyCeremonies(db, send, () => now)).toBe(0);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("leaves the ceremony pending when a send fails", async () => {
    // A closed DM must not consume the notification: the ceremony is real and
    // the message should land the moment it can.
    await detected(3);
    const send = vi.fn().mockRejectedValue(new Error("DMs closed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await notifyCeremonies(db, send, () => now)).toBe(0);
    const [c] = await db.select().from(ceremonies);
    expect(c?.notifiedAt).toBeNull();
    logged.mockRestore();
  });
});
