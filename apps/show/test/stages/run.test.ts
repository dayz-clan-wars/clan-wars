import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, type Fx } from "../fixture.js";
import { runStages } from "../../src/stages/run.js";
import { advance, createEpisode, getEpisode, setFields } from "../../src/stages/store.js";
import { fakeDeps } from "./deps.js";

describe("runStages: production", () => {
  let db: Database; let fx: Fx;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { fx = await makeFixture(db); });

  // Task 9 fills in PUBLISH_STEPS; until then a run stops at "uploaded" (see the interim
  // test below), so the walk-to-approval-wait outcome doesn't exist yet.
  it.todo("walks a new week through to the approval wait, persisting context, screening and script");

  it("walks a new week through context, screening and script, then fails at the missing uploaded step", async () => {
    const f = fakeDeps(db);
    const { outcome, row } = await runStages(f.deps, MON);
    expect(outcome).toBe("failed");
    expect(row.stage).toBe("rendered");
    expect(row.lastError).toMatch(/no step for stage uploaded/u);
    expect(row).toMatchObject({ narrative: "Boris: Hello.\nPavel: Hi.", title: "The Curse", seasonNumber: 1, episodeNumber: 3 });
    expect(row.context).toMatchObject({ week: { season: 1, episode: 3 } });
    expect(row.screeningReport).toMatchObject({ redactions: [], blocked: [], allowed: [], scriptReasons: [], scriptAttempts: 1 });
    expect(f.calls).toMatchObject({ script: 1, render: 1 });
  });

  it("persists the blocked list at the context stage and hands it to the script stage", async () => {
    const sna = await fx.clan({ tag: "SNA" });
    await fx.player("p", "BadName88");
    await fx.member(sna, "p");
    await fx.kill({ at: new Date(MON.getTime() + 3_600_000), killer: "p", victim: "v", killerClan: sna });
    let seenBlocked: string[] = [];
    const f = fakeDeps(db, {
      screen: async (texts) => new Map(texts.map((t) => [t, t === "BadName88" ? { verdict: "block", source: "blocklist", reason: "blocklist: x" } : { verdict: "allow", source: "llm", reason: null }] as const)),
      writeScript: async (_c, blocked) => { seenBlocked = blocked; return { ok: false, reasons: ['attempt 1: blocked text: "BadName88"'], attempts: 2 }; },
    });
    const { outcome, row } = await runStages(f.deps, MON);
    expect(seenBlocked).toEqual(["BadName88"]);
    expect(outcome).toBe("terminal");
    expect(row.stage).toBe("held");
    expect(row.screeningReport).toMatchObject({ blocked: ["BadName88"], scriptReasons: ['attempt 1: blocked text: "BadName88"'] });
    expect(JSON.stringify(row.context)).not.toContain("BadName88");
    const note = f.posted.find((p) => p.channelId === "OPS")!;
    expect(note.msg.content).toContain("held");
    expect(note.msg.content).not.toContain("BadName88");
  });

  it("passes operator-allowed texts to the script stage", async () => {
    await fx.player("p", "Nazgul");
    await fx.kill({ at: new Date(MON.getTime() + 3_600_000), killer: "p", victim: "v" });
    let seenAllowed: string[] = [];
    const f = fakeDeps(db, {
      screen: async (texts) => new Map(texts.map((t) => [t, { verdict: "allow", source: t === "Nazgul" ? "operator" : "llm", reason: null }] as const)),
      writeScript: async (_c, _b, allowed) => { seenAllowed = allowed; return { ok: true, narrative: "Boris: x", title: "T", storylines: [], attempts: 1, reasons: [] }; },
    });
    await runStages(f.deps, MON);
    expect(seenAllowed).toEqual(["Nazgul"]);
  });

  it("never rewrites a stored narrative: resuming at scripted voices the stored one", async () => {
    await runStages(fakeDeps(db, { writeScript: async () => { throw new Error("stop"); } }).deps, MON); // leaves stage=context with a real context
    await advance(db, MON, "scripted", { narrative: "Boris: Stored.", title: "Stored", storylines: [], screeningReport: { redactions: [], blocked: [], allowed: [], scriptReasons: [], scriptAttempts: 1 } });
    const seen: string[] = [];
    const f = fakeDeps(db, { voice: async (ep) => { seen.push(ep.narrative); return { key: "k", mp3Path: "/m", totalSec: 1, segASpan: { startSec: 0, durSec: 1 }, outroSpan: { startSec: 1, durSec: 0 }, timeline: [] }; } });
    await runStages(f.deps, MON);
    expect(f.calls.script).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((n) => n === "Boris: Stored.")).toBe(true);
  });

  it("records a failure, alerts once at the third attempt, and not again at the fourth", async () => {
    const f = fakeDeps(db, { render: async () => { throw new Error("ffmpeg died"); } });
    for (let i = 1; i <= 4; i++) {
      const { outcome, row } = await runStages(f.deps, MON);
      expect(outcome).toBe("failed");
      expect(row).toMatchObject({ stage: "voiced", attempts: i, lastError: "ffmpeg died" });
    }
    const alerts = f.posted.filter((p) => p.channelId === "OPS" && p.msg.content?.includes("has failed"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.msg.content).toContain('"rendered"');
  });

  it("resumes at the stage after the failed one and resets the count", async () => {
    let fail = true;
    const f = fakeDeps(db, { render: async () => { if (fail) throw new Error("x"); return "/v.mp4"; } });
    await runStages(f.deps, MON);
    fail = false;
    // PUBLISH_STEPS is empty in this task, so once render succeeds and the row advances to
    // "rendered", the very next step ("uploaded") has none registered and the run fails
    // immediately at that stage; row.stage stays at "rendered" either way. Task 9 restores
    // this to asserting "awaiting_approval" with attempts: 0 once the publish steps exist.
    const { row } = await runStages(f.deps, MON);
    expect(row).toMatchObject({ stage: "rendered", attempts: 1, lastError: expect.stringMatching(/no step for stage uploaded/u) });
  });

  it("an alert that cannot be posted does not mask the stage failure", async () => {
    const f = fakeDeps(db, { render: async () => { throw new Error("x"); } });
    f.deps.discord.post = async () => { throw new Error("discord down"); };
    for (let i = 0; i < 3; i++) await runStages(f.deps, MON);
    expect((await getEpisode(db, MON))!.attempts).toBe(3);
  });
});
