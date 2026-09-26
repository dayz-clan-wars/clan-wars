import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { SHOW_STAGES } from "@factions/domain";
import {
  createClient, requireTestDatabaseUrl, runMigrations, servers, seasons,
  showEpisodes, showPronunciations, showTextScreening, type Database,
} from "../src/index";

const URL = requireTestDatabaseUrl();
const MON = new Date("2026-09-21T00:00:00Z");

describe("show tables", () => {
  let db: Database; let seasonId = 0;
  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table show_episodes, show_pronunciations, show_text_screening, seasons, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    const [se] = await db.insert(seasons).values({ serverId: s!.id, number: 1, startedAt: new Date("2026-09-08T00:39:17Z") }).returning();
    seasonId = se!.id;
  });

  it("⚠️ the stage CHECK names exactly SHOW_STAGES", async () => {
    const r = await db.execute(sql`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'show_episodes_stage_valid'`);
    const def = String((r as unknown as { def: string }[])[0]!.def);
    for (const s of SHOW_STAGES) expect(def).toContain(`'${s}'`);
    expect(def.match(/'[a-z_]+'/gu)!.length).toBe(SHOW_STAGES.length);
  });

  it("defaults a new episode to stage new, attempts 0", async () => {
    const [e] = await db.insert(showEpisodes).values({ weekStart: MON, seasonId, seasonNumber: 1, episodeNumber: 3 }).returning();
    expect(e!.stage).toBe("new");
    expect(e!.attempts).toBe(0);
  });

  it("refuses a scripted stage without a narrative", async () => {
    await expect(db.insert(showEpisodes).values({ weekStart: MON, seasonId, seasonNumber: 1, episodeNumber: 3, stage: "scripted" }))
      .rejects.toThrow(/show_episodes_narrative_after_script/u);
  });

  it("allows held without a narrative (the script never passed)", async () => {
    await expect(db.insert(showEpisodes).values({ weekStart: MON, seasonId, seasonNumber: 1, episodeNumber: 3, stage: "held" }))
      .resolves.toBeDefined();
  });

  it("one episode number per season", async () => {
    await db.insert(showEpisodes).values({ weekStart: MON, seasonId, seasonNumber: 1, episodeNumber: 3 });
    await expect(db.insert(showEpisodes).values({ weekStart: new Date("2026-09-28T00:00:00Z"), seasonId, seasonNumber: 1, episodeNumber: 3 }))
      .rejects.toThrow(/show_episodes_season_episode_uniq/u);
  });

  it("screening verdict and source are CHECKed, hash is 64 hex", async () => {
    const ok = { textSha256: "a".repeat(64), text: "x", verdict: "allow" as const, source: "llm" as const, reason: null };
    await expect(db.insert(showTextScreening).values(ok)).resolves.toBeDefined();
    await expect(db.insert(showTextScreening).values({ ...ok, textSha256: "b".repeat(64), verdict: "maybe" as never })).rejects.toThrow(/show_text_screening_verdict_valid/u);
    await expect(db.insert(showTextScreening).values({ ...ok, textSha256: "c".repeat(64), source: "vibes" as never })).rejects.toThrow(/show_text_screening_source_valid/u);
    await expect(db.insert(showTextScreening).values({ ...ok, textSha256: "short" })).rejects.toThrow(/show_text_screening_sha_shape/u);
  });

  it("pronunciation source is CHECKed", async () => {
    await expect(db.insert(showPronunciations).values({ text: "SNA", spoken: "S N A", source: "llm" })).resolves.toBeDefined();
    await expect(db.insert(showPronunciations).values({ text: "Z2", spoken: "Zone two", source: "guess" as never })).rejects.toThrow(/show_pronunciations_source_valid/u);
  });
});
