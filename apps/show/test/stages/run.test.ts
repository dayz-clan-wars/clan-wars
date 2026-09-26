import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON, type Fx } from "../fixture.js";
import { runStages } from "../../src/stages/run.js";
import { advance, getEpisode, setFields } from "../../src/stages/store.js";
import { transcriptMessages } from "../../src/stages/text.js";
import { collectNames } from "../../src/produce/names.js";
import type { StoryContext } from "../../src/story/types.js";
import { fakeDeps } from "./deps.js";

describe("runStages: production", () => {
  let db: Database; let fx: Fx;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { fx = await makeFixture(db); });

  it("walks a new week through to the approval wait, persisting context, screening and script", async () => {
    const f = fakeDeps(db);
    const { outcome, row } = await runStages(f.deps, MON);
    expect(outcome).toBe("waiting");
    expect(row.stage).toBe("awaiting_approval");
    expect(row).toMatchObject({ narrative: "Boris: Hello.\nPavel: Hi.", title: "The Curse", seasonNumber: 1, episodeNumber: 3 });
    expect(row.context).toMatchObject({ week: { season: 1, episode: 3 } });
    expect(row.screeningReport).toMatchObject({ redactions: [], blocked: [], allowed: [], scriptReasons: [], scriptAttempts: 1 });
    expect(f.calls.script).toBe(1);
    // Exactly two: the "rendered" step's own render, plus "uploaded"'s cache-hit render on the
    // way to its first upload. Pinning the count catches a stage silently rendering again.
    expect(f.calls.render).toBe(2);
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
    const { row } = await runStages(f.deps, MON);
    expect(row).toMatchObject({ stage: "awaiting_approval", attempts: 0, lastError: null });
  });

  it("an alert that cannot be posted does not mask the stage failure", async () => {
    const f = fakeDeps(db, { render: async () => { throw new Error("x"); } });
    f.deps.discord.post = async () => { throw new Error("discord down"); };
    for (let i = 0; i < 3; i++) await runStages(f.deps, MON);
    expect((await getEpisode(db, MON))!.attempts).toBe(3);
  });

  it("a screen that throws leaves the row at stage new, fails closed", async () => {
    const f = fakeDeps(db, { screen: async () => { throw new Error("screen down"); } });
    const { outcome, row } = await runStages(f.deps, MON);
    expect(outcome).toBe("failed");
    expect(row.stage).toBe("new");
    expect(row.context).toBeNull();
    expect(row.lastError).toBeTruthy();
  });

  it("scrubs the error text from the ops alert when the failing stage is context", async () => {
    const f = fakeDeps(db, { screen: async () => { throw new Error("some sensitive raw text"); } });
    for (let i = 0; i < 3; i++) await runStages(f.deps, MON);
    const alert = f.posted.find((p) => p.channelId === "OPS" && p.msg.content?.includes("has failed"))!;
    expect(alert.msg.content).not.toContain("some sensitive raw text");
    expect(alert.msg.content).toContain("see last_error on the host");
  });

  it("a screen that returns an incomplete verdict map fails closed with the guard's message", async () => {
    const sna = await fx.clan({ tag: "SNA" });
    await fx.player("p", "BadName88");
    await fx.member(sna, "p");
    await fx.kill({ at: new Date(MON.getTime() + 3_600_000), killer: "p", victim: "v", killerClan: sna });
    // A verdict missing for even one registered text must fail the stage, whatever `screen`
    // implementation is injected -- never treated as silently allowed.
    const f = fakeDeps(db, { screen: async (texts) => new Map(texts.slice(1).map((t) => [t, { verdict: "allow", source: "llm", reason: null } as const])) });
    const { outcome, row } = await runStages(f.deps, MON);
    expect(outcome).toBe("failed");
    expect(row.stage).toBe("new");
    expect(row.context).toBeNull();
    expect(row.lastError).toMatch(/screen returned no verdict for/);
  });
});

describe("runStages: publishing", () => {
  let db: Database;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { await makeFixture(db); });

  const draftOf = (f: ReturnType<typeof fakeDeps>) => f.posted.find((p) => p.channelId === "OPS" && p.msg.content?.includes("ready for review"))!;

  it("uploads unlisted with the spec title, drafts once, and stays out of the playlist before approval", async () => {
    const f = fakeDeps(db);
    await runStages(f.deps, MON);
    expect(f.uploads).toMatchObject([{ id: expect.any(String), title: "The Bloodbag and Painkiller Show: Clan Wars S01E03 · The Curse" }]);
    // ⚠️ spec §2.6: nothing is public until an approver reacts ✅ -- an unlisted video sitting in
    // a public playlist is discoverable, so the playlist add waits for the "public" step.
    expect(f.playlist.size).toBe(0);
    expect(f.publicIds.size).toBe(0);
    const d = draftOf(f);
    expect(d.msg.content).toContain("show:2026-09-21");
    expect(f.reactions.get(`${d.id}:✅`)).toEqual(["BOT"]);
    await runStages(f.deps, MON); // a second run with no reactions only waits
    expect(f.posted.filter((p) => p.msg.content?.includes("ready for review"))).toHaveLength(1);
  });

  it("an approver's ✅ publishes: public, forum thread with the link, transcript with mp3, Facebook, done", async () => {
    const f = fakeDeps(db);
    await runStages(f.deps, MON);
    const d = draftOf(f);
    f.reactions.set(`${d.id}:✅`, ["BOT", "ADMIN1"]);
    const { outcome, row } = await runStages(f.deps, MON);
    expect(outcome).toBe("done");
    expect(row).toMatchObject({ stage: "done", approvedByDiscordId: "ADMIN1", forumThreadId: f.threads[0]!.id, facebookVideoId: f.fbVideos[0]!.id });
    expect(row.youtubePublicAt).not.toBeNull();
    expect(f.publicIds.has(row.youtubeVideoId!)).toBe(true);
    expect(f.playlist.has(row.youtubeVideoId!)).toBe(true);
    expect(f.threads[0]).toMatchObject({ forumId: "FORUM", name: "Clan Wars S01E03 · The Curse", first: { content: `https://youtu.be/${row.youtubeVideoId}` } });
    const inThread = f.posted.filter((p) => p.channelId === f.threads[0]!.id);
    expect(inThread).toHaveLength(2);
    expect(inThread[1]!.msg.files![0]!.name).toBe("episode.mp3");
    expect(f.fbVideos[0]!.description).toContain(`https://youtu.be/${row.youtubeVideoId}`);
  });

  it("ignores ✅ from a non-approver and from the bot", async () => {
    const f = fakeDeps(db);
    await runStages(f.deps, MON);
    f.reactions.set(`${draftOf(f).id}:✅`, ["BOT", "RANDOM"]);
    expect((await runStages(f.deps, MON)).row.stage).toBe("awaiting_approval");
  });

  it("ignores the bot's own reactions even if its id is listed as an approver", async () => {
    const f = fakeDeps(db);
    f.deps.cfg = { ...f.deps.cfg, approverIds: ["BOT", "ADMIN1"] };
    await runStages(f.deps, MON);
    const d = draftOf(f);
    // Only the convenience reactions the bot itself added -- no human approver has reacted yet.
    expect(f.reactions.get(`${d.id}:✅`)).toEqual(["BOT"]);
    expect((await runStages(f.deps, MON)).row.stage).toBe("awaiting_approval");
  });

  it("an approver's ❌ rejects, and beats a ✅; the video stays unlisted", async () => {
    const f = fakeDeps(db);
    await runStages(f.deps, MON);
    const d = draftOf(f);
    f.reactions.set(`${d.id}:✅`, ["ADMIN1"]);
    f.reactions.set(`${d.id}:❌`, ["ADMIN1"]);
    const { outcome, row } = await runStages(f.deps, MON);
    expect(outcome).toBe("terminal");
    expect(row).toMatchObject({ stage: "rejected", rejectedByDiscordId: "ADMIN1", youtubePublicAt: null });
    expect(f.publicIds.size).toBe(0);
    expect(f.playlist.size).toBe(0);
  });

  it("with approval off goes from upload straight to public and posted", async () => {
    const f = fakeDeps(db);
    f.deps.cfg = { ...f.deps.cfg, requireApproval: false };
    const { row } = await runStages(f.deps, MON);
    expect(row.stage).toBe("done");
    expect(row.draftMessageId).toBeNull();
    expect(f.posted.some((p) => p.msg.content?.includes("ready for review"))).toBe(false);
  });

  it("crash window: an upload with no row write is adopted, not repeated", async () => {
    const f = fakeDeps(db);
    f.uploads.push({ id: "ytORPHAN", title: "The Bloodbag and Painkiller Show: Clan Wars S01E03 · The Curse", description: "" });
    const { row } = await runStages(f.deps, MON);
    expect(row.youtubeVideoId).toBe("ytORPHAN");
    expect(f.uploads).toHaveLength(1);
  });

  it("crash window: a draft with no row write is adopted by its marker", async () => {
    const f = fakeDeps(db);
    await f.deps.discord.post("OPS", { content: "**Clan Wars S01E03** is ready for review\n-# show:2026-09-21" });
    const { row } = await runStages(f.deps, MON);
    expect(row.draftMessageId).toBe("m1");
    expect(f.posted.filter((p) => p.msg.content?.includes("ready for review"))).toHaveLength(1);
  });

  it("crash window: a forum thread and transcript already posted are not posted again", async () => {
    const f = fakeDeps(db);
    f.deps.cfg = { ...f.deps.cfg, requireApproval: false };
    f.deps.facebook = null;
    let crash = true;
    const realAdvance = f.deps.discord.post;
    f.deps.discord.post = async (c, m) => { const r = await realAdvance(c, m); if (crash && m.files?.[0]?.name === "episode.mp3") { crash = false; throw new Error("crashed after posting"); } return r; };
    await runStages(f.deps, MON); // posts thread + transcript, then "crashes"
    const { row } = await runStages(f.deps, MON);
    expect(row.stage).toBe("done");
    expect(f.threads).toHaveLength(1);
    expect(f.posted.filter((p) => p.channelId === f.threads[0]!.id)).toHaveLength(2);
  });

  it("crash window: a Facebook video with no row write is adopted by its link", async () => {
    const f = fakeDeps(db);
    f.deps.cfg = { ...f.deps.cfg, requireApproval: false };
    await runStages({ ...f.deps, facebook: null }, MON).catch(() => {});
    await setFields(db, MON, { stage: "posted" as never });
    const row0 = (await getEpisode(db, MON))!;
    f.fbVideos.push({ id: "fbORPHAN", description: `watch https://youtu.be/${row0.youtubeVideoId}` });
    const { row } = await runStages(f.deps, MON);
    expect(row.facebookVideoId).toBe("fbORPHAN");
  });

  it("a Facebook failure is logged in the row and does not hold the episode", async () => {
    const f = fakeDeps(db);
    f.deps.cfg = { ...f.deps.cfg, requireApproval: false };
    f.deps.facebook = { find: async () => null, upload: async () => { throw new Error("token expired"); } };
    const { outcome, row } = await runStages(f.deps, MON);
    expect(outcome).toBe("done");
    expect(row).toMatchObject({ stage: "done", facebookVideoId: null, lastError: "facebook: token expired" });
  });

  it("waits for YouTube processing by failing the posted stage, then posts on a later run", async () => {
    const f = fakeDeps(db);
    f.deps.cfg = { ...f.deps.cfg, requireApproval: false };
    let processed = false;
    f.deps.youtube.waitProcessed = async () => processed;
    const first = await runStages(f.deps, MON);
    expect(first).toMatchObject({ outcome: "failed", row: { stage: "public", lastError: "YouTube has not finished processing the video yet" } });
    processed = true;
    expect((await runStages(f.deps, MON)).row.stage).toBe("done");
  });

  it("crash window: a transcript split across messages resumes without re-posting the mp3 message", async () => {
    // A single long line, no newlines, forces `chunk` to hard-split into several embeds that
    // then pack into >= 2 messages -- see transcriptMessages' packing in stages/text.ts.
    const long = `Boris: ${"x ".repeat(4200)}`;
    const f = fakeDeps(db, {
      writeScript: async () => ({ ok: true, narrative: long, title: "The Curse", storylines: [], attempts: 1, reasons: [] }),
    });
    f.deps.cfg = { ...f.deps.cfg, requireApproval: false };
    f.deps.facebook = null;
    let crashed = false;
    const realPost = f.deps.discord.post;
    f.deps.discord.post = async (c, m) => {
      const r = await realPost(c, m);
      if (!crashed && m.files?.[0]?.name === "episode.mp3") { crashed = true; throw new Error("crashed after first transcript message"); }
      return r;
    };
    await runStages(f.deps, MON); // posts the watch-link message + the first transcript message, then "crashes"
    const midRow = (await getEpisode(db, MON))!;
    const expected = transcriptMessages({ narrative: midRow.narrative!, names: collectNames(midRow.context as StoryContext).names, mp3: Buffer.from("BYTES") });
    expect(expected.length).toBeGreaterThanOrEqual(2);
    const { row } = await runStages(f.deps, MON);
    expect(row.stage).toBe("done");
    const inThread = f.posted.filter((p) => p.channelId === f.threads[0]!.id);
    expect(inThread).toHaveLength(1 + expected.length);
    // Never repeated: exactly one message in the thread carries the mp3.
    expect(inThread.filter((p) => p.msg.files?.[0]?.name === "episode.mp3")).toHaveLength(1);
  });

  it("strips em and en dashes from the YouTube title/description and the Facebook caption", async () => {
    const f = fakeDeps(db, {
      writeScript: async () => ({ ok: true, narrative: "Boris: We rode north—then west.\nPavel: A raid – at dawn.", title: "The Curse — Redux", storylines: [], attempts: 1, reasons: [] }),
    });
    f.deps.cfg = { ...f.deps.cfg, requireApproval: false };
    const { row } = await runStages(f.deps, MON);
    expect(row.stage).toBe("done");
    const upload = f.uploads[0]!;
    expect(upload.title).not.toMatch(/[–—]/);
    expect(upload.description).not.toMatch(/[–—]/);
    expect(f.fbVideos[0]!.description).not.toMatch(/[–—]/);
  });
});
