import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, ceremonies, ceremonyParticipants, type Database } from "@factions/db";
import { sql, asc } from "drizzle-orm";
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

  it("delivers to the reachable participants even when one has closed DMs", async () => {
    // One closed DM must not silence the rest of the founding group: the
    // whole point of the DM is that any one of them can run /faction claim.
    await detected(3);
    const send = vi.fn(async (n: { discordId: string }) => {
      if (n.discordId === "101") throw new Error("DMs closed");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await notifyCeremonies(db, send, () => now);
    expect(send.mock.calls.map((c) => c[0].discordId).sort()).toEqual(["100", "101", "102"]);
    logged.mockRestore();
  });

  it("re-sends only to the participant who failed", async () => {
    // Per-participant tracking is the whole reason `notified_at` lives on the
    // participant: retrying the ceremony as a unit re-DMs everyone who already
    // heard, once per tick, for the 24h life of the ceremony.
    await detected(3);
    const send = vi.fn(async (n: { discordId: string }) => {
      if (n.discordId === "101") throw new Error("DMs closed");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await notifyCeremonies(db, send, () => now);
    send.mockClear();
    send.mockResolvedValue(undefined);
    await notifyCeremonies(db, send, () => now);
    expect(send.mock.calls.map((c) => c[0].discordId)).toEqual(["101"]);
    logged.mockRestore();
  });

  it("holds the ceremony's notifiedAt until every participant is delivered", async () => {
    await detected(3);
    const send = vi.fn(async (n: { discordId: string }) => {
      if (n.discordId === "101") throw new Error("DMs closed");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await notifyCeremonies(db, send, () => now)).toBe(0);
    expect((await db.select().from(ceremonies))[0]?.notifiedAt).toBeNull();
    const marked = await db.select().from(ceremonyParticipants).orderBy(asc(ceremonyParticipants.id));
    expect(marked.map((p) => p.notifiedAt !== null)).toEqual([true, false, true]);

    send.mockResolvedValue(undefined);
    expect(await notifyCeremonies(db, send, () => now)).toBe(1);
    expect((await db.select().from(ceremonies))[0]?.notifiedAt).toEqual(now);
    logged.mockRestore();
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
