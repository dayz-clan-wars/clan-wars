import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, at, URL } from "./fixture.js";
import { serviceMain, type ServiceIo } from "../src/service.js";
import { getEpisode, advance, createEpisode } from "../src/stages/store.js";
import { fakeDeps } from "./stages/deps.js";

const ENV = {
  DATABASE_URL: URL, OPENROUTER_API_KEY: "k", SHOW_ENABLED: "1",
  ELEVENLABS_API_KEY: "e", ELEVENLABS_BORIS_VOICE_ID: "b", ELEVENLABS_PAVEL_VOICE_ID: "p",
  DISCORD_TOKEN: "t", DISCORD_GUILD_ID: "111111111111111111", OPS_CHANNEL_ID: "222222222222222222",
  SHOW_FORUM_CHANNEL_ID: "333333333333333333", SHOW_APPROVER_DISCORD_IDS: "444444444444444444",
  YOUTUBE_CLIENT_ID: "a", YOUTUBE_CLIENT_SECRET: "b", YOUTUBE_REFRESH_TOKEN: "c", YOUTUBE_PLAYLIST_ID: "d",
};

describe("serviceMain", () => {
  let db: Database;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { await makeFixture(db); });

  const io = (over: Partial<ServiceIo> = {}): ServiceIo & { lines: string[] } => {
    const lines: string[] = [];
    return {
      lines,
      lock: async () => ({ release: async () => {} }),
      openDb: () => db,
      buildDeps: (d) => fakeDeps(d).deps,
      now: () => at(7, 7),
      log: (s) => lines.push(s),
      ...over,
    };
  };

  it("exits 0 without touching anything when another run holds the lock", async () => {
    const i = io({ lock: async () => null });
    expect(await serviceMain({ force: false, repost: false }, ENV, i)).toBe(0);
    expect(i.lines.join("\n")).toMatch(/another show run/u);
  });

  it("exits 0 when SHOW_ENABLED is off", async () => {
    const i = io();
    expect(await serviceMain({ force: false, repost: false }, { DATABASE_URL: URL }, i)).toBe(0);
    expect(i.lines.join("\n")).toMatch(/SHOW_ENABLED/u);
  });

  it("does nothing when no week is ready", async () => {
    const i = io();
    expect(await serviceMain({ force: false, repost: false }, ENV, i)).toBe(0);
    expect(await getEpisode(db, MON)).toBeNull();
  });

  it("runs the picked week to the approval wait", async () => {
    await db.execute(sql`update seasons set week_closed_through = ${MON.toISOString()}::timestamptz`);
    expect(await serviceMain({ force: false, repost: false }, ENV, io())).toBe(0);
    expect((await getEpisode(db, MON))!.stage).toBe("awaiting_approval");
  });

  it("--week runs that week even when the picker would not", async () => {
    expect(await serviceMain({ week: MON, force: false, repost: false }, ENV, io())).toBe(0);
    expect((await getEpisode(db, MON))!.stage).toBe("awaiting_approval");
  });

  it("--week refuses a week that has not ended yet, exit 2, no row (with or without --force)", async () => {
    const i = io({ now: () => at(6, 23, 59) });
    expect(await serviceMain({ week: MON, force: false, repost: false }, ENV, i)).toBe(2);
    expect(i.lines.join("\n")).toMatch(/has not ended/u);
    expect(await serviceMain({ week: MON, force: true, repost: false }, ENV, i)).toBe(2);
    expect(await getEpisode(db, MON)).toBeNull();
    // The moment the week ends it is allowed.
    expect(await serviceMain({ week: MON, force: false, repost: false }, ENV, io({ now: () => at(7) }))).toBe(0);
  });

  it("exits 1 when a stage fails", async () => {
    const i = io({ buildDeps: (d) => fakeDeps(d, { render: async () => { throw new Error("x"); } }).deps });
    expect(await serviceMain({ week: MON, force: false, repost: false }, ENV, i)).toBe(1);
  });

  it("--force refuses a public episode without --repost, exit 2, row unchanged", async () => {
    await createEpisode(db, MON);
    await advance(db, MON, "posted", { narrative: "Boris: x", youtubePublicAt: new Date() });
    expect(await serviceMain({ week: MON, force: true, repost: false }, ENV, io())).toBe(2);
    expect((await getEpisode(db, MON))!.stage).toBe("posted");
  });

  it("--force without --week or --repost without --force is a usage error", async () => {
    expect(await serviceMain({ force: true, repost: false }, ENV, io())).toBe(2);
    expect(await serviceMain({ week: MON, force: false, repost: true }, ENV, io())).toBe(2);
  });

  it("--force resets a held week and runs it again", async () => {
    await createEpisode(db, MON);
    await advance(db, MON, "held", { screeningReport: { blocked: [] } });
    expect(await serviceMain({ week: MON, force: true, repost: false }, ENV, io())).toBe(0);
    expect((await getEpisode(db, MON))!.stage).toBe("awaiting_approval");
  });

  it("releases the lock even when the run throws", async () => {
    let released = false;
    const i = io({ lock: async () => ({ release: async () => { released = true; } }), buildDeps: () => { throw new Error("wiring"); } });
    await expect(serviceMain({ week: MON, force: false, repost: false }, ENV, i)).rejects.toThrow(/wiring/u);
    expect(released).toBe(true);
  });
});
