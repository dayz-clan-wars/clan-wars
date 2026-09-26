import { describe, it, expect } from "vitest";
import {
  accessTokenFromRefresh,
  uploadVideo,
  waitForVideoProcessed,
  setPrivacy,
  playlistHas,
  addToPlaylist,
  findUploadByTitle,
} from "../../../src/engine/publish/youtube/youtube.js";

type Call = { url: string; init: RequestInit };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
function fake(replies: Response[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return replies.shift() ?? json(200, {}); }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

// KOTH (bot/test/youtube/youtube.test.js at a5ef8e7), ported to TS + vitest.
describe("accessTokenFromRefresh (KOTH)", () => {
  it("POSTs the refresh_token grant and returns the access token", async () => {
    const { calls, fetchImpl } = fake([json(200, { access_token: "AT" })]);
    expect(await accessTokenFromRefresh({ clientId: "cid", clientSecret: "sec", refreshToken: "rt", fetchImpl })).toBe("AT");
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(String(calls[0]!.init.body)).toContain("grant_type=refresh_token");
  });
  it("throws on a non-ok token response", async () => {
    const { fetchImpl } = fake([json(400, { error: "invalid_grant" })]);
    await expect(accessTokenFromRefresh({ clientId: "c", clientSecret: "s", refreshToken: "r", fetchImpl })).rejects.toThrow(/invalid_grant|400/u);
  });
});

describe("uploadVideo (KOTH)", () => {
  it("opens a resumable session then PUTs the bytes, with the given privacy", async () => {
    const { calls, fetchImpl } = fake([json(200, {}, { location: "https://upload.session/uri" }), json(200, { id: "VID" })]);
    const id = await uploadVideo({ accessToken: "AT", filePath: "/x.mp4", title: "T", description: "D", privacy: "unlisted", fetchImpl, fsImpl: { readFileSync: () => Buffer.from("MP4") } });
    expect(id).toBe("VID");
    const meta = JSON.parse(calls[0]!.init.body as string);
    expect(meta).toEqual({ snippet: { title: "T", description: "D", categoryId: "20" }, status: { privacyStatus: "unlisted" } });
    expect(calls[1]!.url).toBe("https://upload.session/uri");
  });
  it("throws when the session init has no Location header", async () => {
    const { fetchImpl } = fake([json(200, {})]);
    await expect(
      uploadVideo({ accessToken: "AT", filePath: "/x", title: "T", description: "D", privacy: "unlisted", fetchImpl, fsImpl: { readFileSync: () => Buffer.from("X") } }),
    ).rejects.toThrow(/resumable session|Location/iu);
  });
});

// KOTH's polling cases, ported verbatim (statusFetch shape kept, jest fakes -> plain functions).
function statusFetch(sequence: string[]): typeof fetch {
  let i = 0;
  return (async () => {
    const s = sequence[Math.min(i++, sequence.length - 1)];
    return json(200, { items: [{ status: { uploadStatus: s } }] });
  }) as unknown as typeof fetch;
}

describe("waitForVideoProcessed (KOTH)", () => {
  it("returns true when the first poll reports processed", async () => {
    const out = await waitForVideoProcessed({
      accessToken: "AT", videoId: "V", fetchImpl: statusFetch(["processed"]),
      now: () => 0, sleep: async () => {},
    });
    expect(out).toBe(true);
  });

  it("polls until processed (sleeps between)", async () => {
    let sleeps = 0;
    const out = await waitForVideoProcessed({
      accessToken: "AT", videoId: "V", fetchImpl: statusFetch(["uploaded", "uploaded", "processed"]),
      now: () => 0, sleep: async () => { sleeps++; },
    });
    expect(out).toBe(true);
    expect(sleeps).toBe(2);
  });

  it("returns false on timeout (still processing at the cap)", async () => {
    const times = [0, 10000, 20000, 30000, 40000];
    let t = 0;
    const out = await waitForVideoProcessed({
      accessToken: "AT", videoId: "V", fetchImpl: statusFetch(["uploaded"]),
      intervalMs: 10000, maxWaitMs: 30000, now: () => times[Math.min(t++, times.length - 1)]!, sleep: async () => {},
    });
    expect(out).toBe(false);
  });

  it("returns false (no throw) on a terminal failed status", async () => {
    const out = await waitForVideoProcessed({
      accessToken: "AT", videoId: "V", fetchImpl: statusFetch(["failed"]),
      now: () => 0, sleep: async () => {},
    });
    expect(out).toBe(false);
  });

  it("returns false (no throw) when the API errors until the cap", async () => {
    const times = [0, 10000, 20000, 30000];
    let t = 0;
    const out = await waitForVideoProcessed({
      accessToken: "AT", videoId: "V",
      fetchImpl: (async () => { throw new Error("network"); }) as unknown as typeof fetch,
      intervalMs: 10000, maxWaitMs: 20000, now: () => times[Math.min(t++, times.length - 1)]!, sleep: async () => {},
    });
    expect(out).toBe(false);
  });
});

describe("setPrivacy", () => {
  it("updates status.privacyStatus with part=status", async () => {
    const { calls, fetchImpl } = fake([json(200, { id: "VID" })]);
    await setPrivacy({ accessToken: "AT", videoId: "VID", privacy: "public", fetchImpl });
    expect(calls[0]!.url).toBe("https://www.googleapis.com/youtube/v3/videos?part=status");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ id: "VID", status: { privacyStatus: "public" } });
  });
  it("throws on failure", async () => {
    const { fetchImpl } = fake([json(403, { error: { message: "insufficientPermissions" } })]);
    await expect(setPrivacy({ accessToken: "AT", videoId: "V", privacy: "public", fetchImpl })).rejects.toThrow(/403/u);
  });
});

describe("playlists", () => {
  it("playlistHas asks for the one video in the playlist", async () => {
    const { calls, fetchImpl } = fake([json(200, { items: [{ id: "pi" }] }), json(200, { items: [] })]);
    expect(await playlistHas({ accessToken: "AT", playlistId: "PL", videoId: "V", fetchImpl })).toBe(true);
    expect(await playlistHas({ accessToken: "AT", playlistId: "PL", videoId: "V", fetchImpl })).toBe(false);
    expect(calls[0]!.url).toBe("https://www.googleapis.com/youtube/v3/playlistItems?part=id&playlistId=PL&videoId=V");
  });
  it("addToPlaylist inserts a playlistItem", async () => {
    const { calls, fetchImpl } = fake([json(200, { id: "pi" })]);
    await addToPlaylist({ accessToken: "AT", playlistId: "PL", videoId: "V", fetchImpl });
    expect(calls[0]!.url).toBe("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ snippet: { playlistId: "PL", resourceId: { kind: "youtube#video", videoId: "V" } } });
  });
});

describe("findUploadByTitle", () => {
  const channel = () => json(200, { items: [{ contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] });
  it("looks through the channel's uploads playlist for the exact title and description", async () => {
    const { calls, fetchImpl } = fake([
      channel(),
      json(200, { items: [
        { snippet: { title: "Other", description: "D", resourceId: { videoId: "a" } } },
        { snippet: { title: "Wanted", description: "D", resourceId: { videoId: "b" } } },
      ] }),
    ]);
    expect(await findUploadByTitle({ accessToken: "AT", title: "Wanted", description: "D", fetchImpl })).toBe("b");
    expect(calls[0]!.url).toBe("https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true");
    expect(calls[1]!.url).toBe("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=UU1");
  });
  it("never matches an older cut with the same title but another description", async () => {
    const { fetchImpl } = fake([channel(), json(200, { items: [{ snippet: { title: "Wanted", description: "old cut", resourceId: { videoId: "old" } } }] })]);
    expect(await findUploadByTitle({ accessToken: "AT", title: "Wanted", description: "new cut", fetchImpl })).toBeNull();
  });
  it("returns null when no upload has the title", async () => {
    const { fetchImpl } = fake([channel(), json(200, { items: [] })]);
    expect(await findUploadByTitle({ accessToken: "AT", title: "Wanted", description: "D", fetchImpl })).toBeNull();
  });
});
