import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "@factions/db";
import { publishSpecial, type SpecialState } from "../../src/special/publish.js";
import { specialMarker } from "../../src/special/text.js";
import { loadSpecial, type Special } from "../../src/special/load.js";
import { APPROVE, REJECT } from "../../src/stages/approval.js";
import { fakeDeps } from "../stages/deps.js";

const REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../specials/2026-10-nasdara");
const THREAD = "Clan Wars Special · New to Clan Wars? Start here";

let special: Special;
let out: { videoPath: string; mp3Path: string; statePath: string };
beforeEach(() => {
  special = loadSpecial(REAL);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "special-pub-"));
  out = { videoPath: path.join(dir, "video.mp4"), mp3Path: path.join(dir, "episode.mp3"), statePath: path.join(dir, "publish-state.json") };
});

const harness = () => fakeDeps({} as Database);
const draftOf = (h: ReturnType<typeof harness>) => h.posted.find((p) => p.channelId === "OPS")!;
const state = (): SpecialState => JSON.parse(fs.readFileSync(out.statePath, "utf8"));

describe("publishSpecial", () => {
  it("waits at approval, then finishes after an approver ✅", async () => {
    const h = harness();
    expect(await publishSpecial(h.deps, special, out)).toBe("waiting");
    expect(h.uploads).toHaveLength(1);
    expect(h.uploads[0]!.title).toBe("The Bloodbag and Painkiller Show: Clan Wars Special · New to Clan Wars? Start here");
    expect(h.uploads[0]!.description.startsWith("Clan Wars moved to Nasdara.")).toBe(true);
    expect(h.posted.filter((p) => p.channelId === "OPS")).toHaveLength(1);
    expect(draftOf(h).msg.content).toContain(specialMarker(special.slug, special.narrative));
    expect(h.publicIds.size).toBe(0);
    expect(h.playlist.size).toBe(0);

    // A re-run while still waiting posts nothing new.
    expect(await publishSpecial(h.deps, special, out)).toBe("waiting");
    expect(h.uploads).toHaveLength(1);
    expect(h.posted.filter((p) => p.channelId === "OPS")).toHaveLength(1);

    h.reactions.set(`${draftOf(h).id}:${APPROVE}`, ["BOT", "ADMIN1"]);
    expect(await publishSpecial(h.deps, special, out)).toBe("done");
    const vid = h.uploads[0]!.id;
    expect([...h.publicIds]).toEqual([vid]);
    expect([...h.playlist]).toEqual([vid]);
    expect(h.threads.map((t) => t.name)).toEqual([THREAD]);
    expect(h.threads[0]!.first.content).toBe(`https://youtu.be/${vid}`);
    expect(h.posted.filter((p) => p.channelId === h.threads[0]!.id).length).toBeGreaterThan(1);
    expect(h.fbVideos).toHaveLength(1);
    expect(state().approvedBy).toBe("ADMIN1");
    expect(state().doneAt).toBeTruthy();

    // Done is done: a further run changes nothing.
    const before = h.posted.length;
    expect(await publishSpecial(h.deps, special, out)).toBe("done");
    expect(h.posted.length).toBe(before);
    expect(h.fbVideos).toHaveLength(1);
  });

  it("a non-approver ✅ keeps it waiting", async () => {
    const h = harness();
    await publishSpecial(h.deps, special, out);
    h.reactions.set(`${draftOf(h).id}:${APPROVE}`, ["RANDOM"]);
    expect(await publishSpecial(h.deps, special, out)).toBe("waiting");
    expect(h.publicIds.size).toBe(0);
  });

  it("❌ ends it rejected and nothing goes public", async () => {
    const h = harness();
    await publishSpecial(h.deps, special, out);
    h.reactions.set(`${draftOf(h).id}:${REJECT}`, ["ADMIN1"]);
    expect(await publishSpecial(h.deps, special, out)).toBe("rejected");
    h.reactions.set(`${draftOf(h).id}:${APPROVE}`, ["ADMIN1"]);
    expect(await publishSpecial(h.deps, special, out)).toBe("rejected");
    expect(h.publicIds.size).toBe(0);
    expect(h.threads).toHaveLength(0);
    expect(state().rejectedBy).toBe("ADMIN1");
  });

  it("a crash after upload adopts the existing upload", async () => {
    const h = harness();
    await publishSpecial(h.deps, special, out);
    fs.rmSync(out.statePath);
    expect(await publishSpecial(h.deps, special, out)).toBe("waiting");
    expect(h.uploads).toHaveLength(1);
    // ...and the existing draft too, found by its marker.
    expect(h.posted.filter((p) => p.channelId === "OPS")).toHaveLength(1);
  });

  it("an existing thread whose starter is this link is adopted, not recreated", async () => {
    const h = harness();
    await publishSpecial(h.deps, special, out);
    h.reactions.set(`${draftOf(h).id}:${APPROVE}`, ["ADMIN1"]);
    const vid = h.uploads[0]!.id;
    const { threadId } = await h.deps.discord.createForumThread("FORUM", THREAD, { content: `https://youtu.be/${vid}` });
    expect(await publishSpecial(h.deps, special, out)).toBe("done");
    expect(h.threads).toHaveLength(1);
    expect(state().forumThreadId).toBe(threadId);
  });

  it("a facebook failure still finishes done with facebookError set", async () => {
    const h = harness();
    h.deps.facebook = { find: async () => null, upload: async () => { throw new Error("fb down"); } };
    await publishSpecial(h.deps, special, out);
    h.reactions.set(`${draftOf(h).id}:${APPROVE}`, ["ADMIN1"]);
    expect(await publishSpecial(h.deps, special, out)).toBe("done");
    expect(state().facebookError).toContain("fb down");
  });

  it("a changed script returns cut-mismatch and calls nothing", async () => {
    const h = harness();
    await publishSpecial(h.deps, special, out);
    const posted = h.posted.length;
    const changed = { ...special, narrative: `${special.narrative}\nBoris: One more line.` };
    expect(await publishSpecial(h.deps, changed, out)).toBe("cut-mismatch");
    expect(h.uploads).toHaveLength(1);
    expect(h.posted.length).toBe(posted);
  });

  it("no ops channel fails instead of publishing without approval", async () => {
    const h = harness();
    h.deps.cfg = { ...h.deps.cfg, opsChannelId: null };
    await expect(publishSpecial(h.deps, special, out)).rejects.toThrow(/OPS_CHANNEL_ID/);
    expect(h.publicIds.size).toBe(0);
  });
});
