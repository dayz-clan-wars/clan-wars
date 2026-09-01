import { describe, it, expect, vi } from "vitest";
import { NitradoClient } from "../src/client.js";

const GS = { data: { gameserver: { game_specific: { path: "/games/ni1234/noftp/dayzxb/" } } } };

/** Serves canned JSON by URL substring, so a test states only what it cares about. */
function fakeFetch(routes: Record<string, unknown>, text?: string) {
  return vi.fn(async (url: string) => {
    if (text !== undefined && url.startsWith("https://dl.nitrado")) {
      return { ok: true, text: async () => text } as unknown as Response;
    }
    for (const [frag, body] of Object.entries(routes)) {
      if (url.includes(frag)) return { ok: true, json: async () => body } as unknown as Response;
    }
    return { ok: false, status: 404 } as unknown as Response;
  });
}

const listing = (entries: unknown[]) => ({ data: { entries } });

describe("NitradoClient.listAdmFiles", () => {
  it("returns ADM files oldest-first by their filename timestamp", async () => {
    // Nitrado's listing order is not guaranteed. Ordering is load-bearing:
    // the tick backfills oldest-first, and a file's timestamps depend on
    // every file before it.
    const fetchFn = fakeFetch({
      "/gameservers/settings": {},
      "/file_server/list": listing([
        { name: "DayZServer_X1_x64_2026-07-23_01-00-00.ADM", path: "/b.ADM", modified_at: 200 },
        { name: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM", path: "/a.ADM", modified_at: 100 },
      ]),
      "/gameservers": GS,
    });
    const files = await new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).listAdmFiles();
    expect(files.map((f) => f.path)).toEqual(["/a.ADM", "/b.ADM"]);
  });

  it("ignores entries that are not ADM files", async () => {
    const fetchFn = fakeFetch({
      "/file_server/list": listing([
        { name: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM", path: "/a.ADM", modified_at: 100 },
        { name: "server.cfg", path: "/server.cfg", modified_at: 100 },
      ]),
      "/gameservers": GS,
    });
    const files = await new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).listAdmFiles();
    expect(files).toHaveLength(1);
  });

  it("reports a missing modified_at as 0 rather than dropping the file", async () => {
    // ⚠️ The 0 matters downstream: the clock-offset derivation must EXCLUDE
    // these, because a 0 would win its minimum and shift every timestamp by
    // decades. The client's job is to report the absence faithfully.
    const fetchFn = fakeFetch({
      "/file_server/list": listing([
        { name: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM", path: "/a.ADM" },
      ]),
      "/gameservers": GS,
    });
    const [f] = await new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).listAdmFiles();
    expect(f?.modifiedAtMs).toBe(0);
  });

  it("reports an unparseable filename as a null local timestamp", async () => {
    const fetchFn = fakeFetch({
      "/file_server/list": listing([{ name: "weird.ADM", path: "/w.ADM", modified_at: 100 }]),
      "/gameservers": GS,
    });
    const [f] = await new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).listAdmFiles();
    expect(f?.localTimestampMs).toBeNull();
  });

  it("throws when the gameserver path cannot be resolved", async () => {
    const fetchFn = fakeFetch({ "/gameservers": { data: {} } });
    await expect(new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).listAdmFiles())
      .rejects.toThrow(/could not resolve gameserver path/);
  });

  it("throws on a non-ok response", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 401 } as unknown as Response));
    await expect(new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).listAdmFiles())
      .rejects.toThrow(/401/);
  });
});

describe("NitradoClient.downloadFile", () => {
  it("follows the token url the API returns", async () => {
    // The download endpoint returns a URL, not the bytes. A client that
    // returned the JSON body would silently ingest an API envelope as if it
    // were log lines.
    const fetchFn = fakeFetch(
      { "/file_server/download": { data: { token: { url: "https://dl.nitrado.net/x" } } } },
      "AdminLog started on 2026-07-22 at 07:01:37",
    );
    const text = await new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).downloadFile("/a.ADM");
    expect(text).toContain("AdminLog started on");
  });

  it("throws when no download url is returned", async () => {
    const fetchFn = fakeFetch({ "/file_server/download": { data: {} } });
    await expect(new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).downloadFile("/a.ADM"))
      .rejects.toThrow(/no download url/);
  });
});
