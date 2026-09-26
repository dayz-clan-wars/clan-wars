import { describe, it, expect } from "vitest";
import { uploadPageVideo, findPageVideoByLink } from "../../../src/engine/publish/facebook/facebook.js";
import { buildFacebookCaption } from "../../../src/engine/publish/facebook/buildFacebookCaption.js";

describe("uploadPageVideo (KOTH)", () => {
  it("POSTs multipart to /{page}/videos and returns the id", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: "FB" }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await uploadPageVideo({ pageId: "123", accessToken: "PAT", filePath: "/x.mp4", description: "hello", fetchImpl, fsImpl: { readFileSync: () => Buffer.from("MP4") } })).toBe("FB");
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v21.0/123/videos");
    const form = calls[0]!.init.body as FormData;
    expect(form.get("access_token")).toBe("PAT");
    expect(form.get("description")).toBe("hello");
  });
  it("throws with the Graph error on non-2xx", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: "bad token" } }), { status: 400 })) as unknown as typeof fetch;
    await expect(uploadPageVideo({ pageId: "1", accessToken: "t", filePath: "/x", description: "d", fetchImpl, fsImpl: { readFileSync: () => Buffer.from("X") } })).rejects.toThrow(/bad token|400/u);
  });
});

describe("findPageVideoByLink", () => {
  it("finds the recent Page video whose description carries the link", async () => {
    let seen = "";
    const fetchImpl = (async (url: string) => { seen = url; return new Response(JSON.stringify({ data: [{ id: "a", description: "x" }, { id: "b", description: "watch https://youtu.be/V1" }] }), { status: 200 }); }) as unknown as typeof fetch;
    expect(await findPageVideoByLink({ pageId: "9", accessToken: "PAT", link: "https://youtu.be/V1", fetchImpl })).toBe("b");
    expect(seen).toBe("https://graph.facebook.com/v21.0/9/videos?fields=id%2Cdescription&limit=10&access_token=PAT");
  });
  it("returns null when none matches", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    expect(await findPageVideoByLink({ pageId: "9", accessToken: "PAT", link: "https://youtu.be/V1", fetchImpl })).toBeNull();
  });
});

describe("buildFacebookCaption", () => {
  const c = buildFacebookCaption({ code: "S01E03", subtitle: "The Curse", youtubeVideoId: "V1", discordInvite: "discord.gg/TJu4XP25nr" });
  it("names the episode, links YouTube and the Discord", () => {
    expect(c).toContain("Clan Wars S01E03 · The Curse");
    expect(c).toContain("https://youtu.be/V1");
    expect(c).toContain("https://discord.gg/TJu4XP25nr");
  });
  it("has no em or en dash and says clan, not faction", () => {
    expect(c).not.toMatch(/[–—]/u);
    expect(c).not.toMatch(/faction/iu);
  });
});
