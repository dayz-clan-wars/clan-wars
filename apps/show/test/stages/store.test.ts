import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, type Fx } from "../fixture.js";
import { advance, createEpisode, forceWeek, getEpisode, recordFailure, setFields } from "../../src/stages/store.js";

describe("episode store", () => {
  let db: Database; let fx: Fx;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { fx = await makeFixture(db); });

  it("creates the row once, freezing season and episode numbers", async () => {
    const a = await createEpisode(db, MON);
    const b = await createEpisode(db, MON);
    expect(a).toMatchObject({ stage: "new", seasonId: fx.seasonId, seasonNumber: 1, episodeNumber: 3, attempts: 0 });
    expect(b.createdAt.getTime()).toBe(a.createdAt.getTime());
  });

  it("advance moves the stage, writes fields and clears the failure count", async () => {
    await createEpisode(db, MON);
    await recordFailure(db, MON, "boom");
    const r = await advance(db, MON, "context", { context: { x: 1 } });
    expect(r).toMatchObject({ stage: "context", context: { x: 1 }, attempts: 0, lastError: null });
  });

  it("setFields writes without moving the stage", async () => {
    await createEpisode(db, MON);
    const r = await setFields(db, MON, { youtubeVideoId: "vid" });
    expect(r).toMatchObject({ stage: "new", youtubeVideoId: "vid" });
  });

  it("recordFailure counts and keeps the latest error", async () => {
    await createEpisode(db, MON);
    expect(await recordFailure(db, MON, "one")).toBe(1);
    expect(await recordFailure(db, MON, "two")).toBe(2);
    expect((await getEpisode(db, MON))!.lastError).toBe("two");
  });

  it("forceWeek resets a held row to new, clearing everything after it", async () => {
    await fx.episode({ weekStart: MON, episodeNumber: 3, title: null, storylines: null, narrative: null, stage: "held" });
    await setFields(db, MON, { context: { x: 1 }, screeningReport: { r: 1 }, attempts: 2, lastError: "e" });
    expect(await forceWeek(db, MON, { repost: false })).toBe("reset");
    expect(await getEpisode(db, MON)).toMatchObject({ stage: "new", context: null, narrative: null, screeningReport: null, attempts: 0, lastError: null });
  });

  it("forceWeek refuses a public episode without --repost and changes nothing", async () => {
    await fx.episode({ weekStart: MON, episodeNumber: 3, title: "T", storylines: [], narrative: "Boris: hi", stage: "posted" });
    await setFields(db, MON, { youtubeVideoId: "vid", youtubePublicAt: new Date(), forumThreadId: "th" });
    expect(await forceWeek(db, MON, { repost: false })).toBe("public-needs-repost");
    expect(await getEpisode(db, MON)).toMatchObject({ stage: "posted", narrative: "Boris: hi", forumThreadId: "th" });
  });

  it("forceWeek with --repost clears the published ids too", async () => {
    await fx.episode({ weekStart: MON, episodeNumber: 3, title: "T", storylines: [], narrative: "Boris: hi", stage: "done" });
    await setFields(db, MON, { youtubeVideoId: "vid", youtubePublicAt: new Date(), forumThreadId: "th", discordPostedAt: new Date(), facebookVideoId: "fb", draftMessageId: "d", approvedByDiscordId: "a", approvedAt: new Date() });
    expect(await forceWeek(db, MON, { repost: true })).toBe("reset");
    expect(await getEpisode(db, MON)).toMatchObject({
      stage: "new", youtubeVideoId: null, youtubePublicAt: null, forumThreadId: null, discordPostedAt: null,
      facebookVideoId: null, draftMessageId: null, approvedByDiscordId: null, approvedAt: null,
    });
  });

  it("forceWeek on a missing row says so", async () => {
    expect(await forceWeek(db, MON, { repost: false })).toBe("missing");
  });
});
