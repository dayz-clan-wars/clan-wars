import { describe, it, expect } from "vitest";
import { createDiscord, DISCORD_USER_AGENT } from "../../../src/engine/publish/discord.js";

type Call = { url: string; init: RequestInit };
function fakeFetch(replies: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies.shift() ?? { status: 200, body: {} };
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const headers = (c: Call) => new Headers(c.init.headers);

describe("createDiscord", () => {
  it("posts JSON with the bot token, a User-Agent and no mentions", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 200, body: { id: "m1" } }]);
    const d = createDiscord({ token: "T", fetchImpl });
    expect(await d.post("c1", { content: "hi @everyone" })).toEqual({ id: "m1" });
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/c1/messages");
    expect(headers(calls[0]!).get("authorization")).toBe("Bot T");
    expect(headers(calls[0]!).get("user-agent")).toBe(DISCORD_USER_AGENT);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ content: "hi @everyone", allowed_mentions: { parse: [] } });
  });

  it("posts files as multipart with payload_json", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 200, body: { id: "m2" } }]);
    const d = createDiscord({ token: "T", fetchImpl });
    await d.post("c1", { content: "x", files: [{ name: "episode.mp3", data: Buffer.from("MP3"), contentType: "audio/mpeg" }] });
    const form = calls[0]!.init.body as FormData;
    expect(JSON.parse(form.get("payload_json") as string)).toEqual({ content: "x", allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: "episode.mp3" }] });
    expect((form.get("files[0]") as File).name).toBe("episode.mp3");
    expect(headers(calls[0]!).get("content-type")).toBeNull(); // fetch sets the multipart boundary itself
  });

  it("waits out a 429 and retries", async () => {
    const waits: number[] = [];
    const { calls, fetchImpl } = fakeFetch([{ status: 429, body: { retry_after: 1.5 } }, { status: 200, body: { id: "m3" } }]);
    const d = createDiscord({ token: "T", fetchImpl, sleep: async (ms) => { waits.push(ms); } });
    expect(await d.post("c1", { content: "x" })).toEqual({ id: "m3" });
    expect(calls).toHaveLength(2);
    expect(waits[0]).toBe(1750);
  });

  it("throws on any other failure with the status", async () => {
    const { fetchImpl } = fakeFetch([{ status: 403, body: { message: "Missing Access" } }]);
    await expect(createDiscord({ token: "T", fetchImpl }).post("c1", { content: "x" })).rejects.toThrow(/403/u);
  });

  it("reads reaction users for a url-encoded emoji", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 200, body: [{ id: "u1" }, { id: "u2" }] }]);
    expect(await createDiscord({ token: "T", fetchImpl }).reactionUserIds("c", "m", "✅")).toEqual(["u1", "u2"]);
    expect(calls[0]!.url).toBe(`https://discord.com/api/v10/channels/c/messages/m/reactions/${encodeURIComponent("✅")}?limit=100`);
  });

  it("adds a reaction with PUT to @me", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 204 }]);
    await createDiscord({ token: "T", fetchImpl }).react("c", "m", "❌");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(calls[0]!.url).toBe(`https://discord.com/api/v10/channels/c/messages/m/reactions/${encodeURIComponent("❌")}/@me`);
  });

  it("maps recent messages to their author, embed and attachment counts", async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: [{ id: "1", content: "a", author: { id: "bot" }, embeds: [{}], attachments: [{}, {}] }] }]);
    expect(await createDiscord({ token: "T", fetchImpl }).recentMessages("c", 10)).toEqual([{ id: "1", content: "a", authorId: "bot", embeds: 1, attachments: 2 }]);
  });

  it("creates a forum thread whose first message is the given one", async () => {
    const { calls, fetchImpl } = fakeFetch([{ status: 201, body: { id: "th1" } }]);
    expect(await createDiscord({ token: "T", fetchImpl }).createForumThread("f", "Clan Wars S01E03 · T", { content: "https://youtu.be/v" })).toEqual({ threadId: "th1" });
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/channels/f/threads");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ name: "Clan Wars S01E03 · T", message: { content: "https://youtu.be/v", allowed_mentions: { parse: [] } } });
  });

  it("finds a forum thread by exact name among active, then archived, threads", async () => {
    const { calls, fetchImpl } = fakeFetch([
      { status: 200, body: { threads: [{ id: "x", parent_id: "other", name: "N" }] } },
      { status: 200, body: { threads: [{ id: "t9", parent_id: "f", name: "N" }], has_more: false } },
    ]);
    expect(await createDiscord({ token: "T", fetchImpl }).findForumThread("g", "f", "N")).toBe("t9");
    expect(calls[0]!.url).toBe("https://discord.com/api/v10/guilds/g/threads/active");
    expect(calls[1]!.url).toBe("https://discord.com/api/v10/channels/f/threads/archived/public?limit=100");
  });

  it("returns null when no thread has the name", async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: { threads: [] } }, { status: 200, body: { threads: [], has_more: false } }]);
    expect(await createDiscord({ token: "T", fetchImpl }).findForumThread("g", "f", "N")).toBeNull();
  });
});
