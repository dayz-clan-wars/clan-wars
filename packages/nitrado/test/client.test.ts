import { describe, it, expect, vi } from "vitest";
import { NitradoClient } from "../src/client.js";

const GS = { status: "success", data: { gameserver: { game_specific: { path: "/games/ni1234/noftp/dayzxb/" } } } };

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

// All routed fixture bodies below carry status:"success" — Nitrado wraps
// every real response this way, and getJson now rejects anything else.
const listing = (entries: unknown[]) => ({ status: "success", data: { entries } });

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

  it("drops files with unparseable filenames, preserving oldest-first ordering invariant", async () => {
    // Unparseable filenames (ones not matching the naming regex) are dropped,
    // not kept with a null timestamp. A null would coerce to 0 in sorting,
    // placing it at the front ahead of genuinely old files and violating
    // the oldest-first ordering that the ingest tick depends on.
    const fetchFn = fakeFetch({
      "/file_server/list": listing([
        { name: "DayZServer_X1_x64_2026-07-23_01-00-00.ADM", path: "/b.ADM", modified_at: 200 },
        { name: "weird.ADM", path: "/w.ADM", modified_at: 100 },
        { name: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM", path: "/a.ADM", modified_at: 100 },
      ]),
      "/gameservers": GS,
    });
    const files = await new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).listAdmFiles();
    expect(files.map((f) => f.path)).toEqual(["/a.ADM", "/b.ADM"]);
  });

  it("throws when the gameserver path cannot be resolved", async () => {
    const fetchFn = fakeFetch({ "/gameservers": { status: "success", data: {} } });
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
      { "/file_server/download": { status: "success", data: { token: { url: "https://dl.nitrado.net/x" } } } },
      "AdminLog started on 2026-07-22 at 07:01:37",
    );
    const text = await new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).downloadFile("/a.ADM");
    expect(text).toContain("AdminLog started on");
  });

  it("throws when no download url is returned", async () => {
    const fetchFn = fakeFetch({ "/file_server/download": { status: "success", data: {} } });
    await expect(new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).downloadFile("/a.ADM"))
      .rejects.toThrow(/no download url/);
  });
});

describe("NitradoClient.uploadFile", () => {
  it("uploads via the two-step token flow", async () => {
    const calls: { url: string; init: any }[] = [];
    const fake = async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("file_server/upload")) {
        return new Response(JSON.stringify({ status: "success", data: { token: { url: "https://up.example/put", token: "T0K" } } }), { status: 200 });
      }
      return new Response("", { status: 200 });
    };
    const c = new NitradoClient("tok", 42, fake as any);
    await c.uploadFile("/games/x/ftproot/dayzxb/mission/custom", "faction-supplies.json", "{}");

    expect(calls[0]!.url).toContain("/services/42/gameservers/file_server/upload");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ path: "/games/x/ftproot/dayzxb/mission/custom", file: "faction-supplies.json" });
    // ⚠️ The second POST carries the token in a bare `token` HEADER — not a
    // bearer, not a query parameter — with an application/binary body.
    expect(calls[1]!.url).toBe("https://up.example/put");
    expect(calls[1]!.init.headers.token).toBe("T0K");
    expect(calls[1]!.init.headers["Content-Type"]).toBe("application/binary");
    expect(calls[1]!.init.body).toBe("{}");
  });

  it("treats HTTP 200 with a failure payload as a failure", async () => {
    // ⚠️ Nitrado answers some errors with 200 and status:"error". Trusting
    // res.ok alone would record a hash for a file that was never written, and
    // the supply projection would then never retry.
    const fake = async () =>
      new Response(JSON.stringify({ status: "error", message: "nope" }), { status: 200 });
    const c = new NitradoClient("tok", 42, fake as any);
    await expect(c.uploadFile("/dir", "f.json", "{}")).rejects.toThrow(/nope|error/i);
  });

  it("fails when the upload token url is missing", async () => {
    const fake = async () => new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 });
    const c = new NitradoClient("tok", 42, fake as any);
    await expect(c.uploadFile("/dir", "f.json", "{}")).rejects.toThrow(/missing token url/);
  });

  it("fails when the upload token itself is missing", async () => {
    // ⚠️ Distinct from the missing-url case above: the url check on the line
    // before runs first, so a fixture that omits BOTH would only ever
    // exercise the url branch. This fixture supplies a url but omits `token`,
    // so it reaches the second guard specifically.
    const fake = async () =>
      new Response(JSON.stringify({ status: "success", data: { token: { url: "https://up.example/put" } } }), { status: 200 });
    const c = new NitradoClient("tok", 42, fake as any);
    await expect(c.uploadFile("/dir", "f.json", "{}")).rejects.toThrow(/missing token for/);
  });

  it("rejects a binary POST that answers 200 with a failure payload", async () => {
    // ⚠️ Distinct from the 200-with-failure test above, which fails on STEP
    // ONE (the token request, guarded by assertSuccess). Here step one
    // succeeds and only the signed-URL POST — the call that actually writes
    // the bytes — answers 200 with status:"error". Without the body check in
    // uploadFile this resolves, supply-tick advances the stored hash, and the
    // server file diverges from the database forever with nothing retrying.
    const fake = async (url: string) =>
      String(url).includes("file_server/upload")
        ? new Response(JSON.stringify({ status: "success", data: { token: { url: "https://up.example/put", token: "T" } } }), { status: 200 })
        : new Response(JSON.stringify({ status: "error", message: "quota exceeded" }), { status: 200 });
    const c = new NitradoClient("tok", 42, fake as any);
    await expect(c.uploadFile("/dir", "f.json", "{}")).rejects.toThrow(/quota exceeded/);
  });

  it("accepts a binary POST that answers 200 with an empty body", async () => {
    // ⚠️ The other half of the guard, and the half that protects the working
    // deployment: nobody has verified that this endpoint returns an envelope
    // at all. An empty (or non-JSON) body MUST stay a success — asserting
    // status === "success" unconditionally would break every real upload.
    const fake = async (url: string) =>
      String(url).includes("file_server/upload")
        ? new Response(JSON.stringify({ status: "success", data: { token: { url: "https://up.example/put", token: "T" } } }), { status: 200 })
        : new Response("", { status: 200 });
    const c = new NitradoClient("tok", 42, fake as any);
    await expect(c.uploadFile("/dir", "f.json", "{}")).resolves.toBeUndefined();
  });

  it("accepts a binary POST whose body is not JSON", async () => {
    const fake = async (url: string) =>
      String(url).includes("file_server/upload")
        ? new Response(JSON.stringify({ status: "success", data: { token: { url: "https://up.example/put", token: "T" } } }), { status: 200 })
        : new Response("OK", { status: 200 });
    const c = new NitradoClient("tok", 42, fake as any);
    await expect(c.uploadFile("/dir", "f.json", "{}")).resolves.toBeUndefined();
  });

  it("fails when the binary POST is rejected", async () => {
    const fake = async (url: string) =>
      String(url).includes("file_server/upload")
        ? new Response(JSON.stringify({ status: "success", data: { token: { url: "https://up.example/put", token: "T" } } }), { status: 200 })
        : new Response("denied", { status: 403 });
    const c = new NitradoClient("tok", 42, fake as any);
    await expect(c.uploadFile("/dir", "f.json", "{}")).rejects.toThrow(/403/);
  });
});

describe("NitradoClient request timeout", () => {
  it("aborts a request that never responds", async () => {
    // ⚠️ Without a deadline a stalled connection blocks the entire sequential
    // sweep until undici's ~300s default, with nothing logged while it hangs.
    const fetchFn = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    const client = new NitradoClient("t", 1, fetchFn as unknown as typeof fetch, 10);
    await expect(client.listAdmFiles()).rejects.toThrow(/timeout/i);
  });

  it("passes the deadline to the download request too", async () => {
    // Only the signed-URL fetch stalls; the API call that hands it over is fine.
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://api.nitrado.net")) {
        return { ok: true, json: async () => ({ status: "success", data: { token: { url: "https://dl.nitrado/x" } } }) } as unknown as Response;
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    });
    const client = new NitradoClient("t", 1, fetchFn as unknown as typeof fetch, 10);
    await expect(client.downloadFile("/a.ADM")).rejects.toThrow(/timeout/i);
  });
});

/**
 * The real shape, from service 19831378 on 2026-09-02. The mission custom dir
 * is NOT under game_specific.path (which is the `noftp` tree and exposes only
 * config/); it lives in the sibling `ftproot` tree, and `paths_available` is
 * null, so the path has to be composed from these three fields.
 */
const GS_FULL = {
  status: "success",
  data: {
    gameserver: {
      username: "ni11558038_4",
      game: "dayzxb",
      game_specific: { path: "/games/ni11558038_4/noftp/dayzxb/", paths_available: null },
      settings: { config: { mission: "dayzOffline.enoch" } },
    },
  },
};

describe("NitradoClient.missionCustomDir", () => {
  const client = (gs: unknown) =>
    new NitradoClient("t", 1, fakeFetch({ "/gameservers": gs }) as unknown as typeof fetch);

  it("composes the mission custom directory from username, game and mission", async () => {
    // ⚠️ Verified against the live file server on 2026-09-02: this exact path
    // lists faction-supplies.json. The `ni11558038_4` segment is the
    // gameserver USERNAME, not the Nitrado service id (19831378) — which is
    // why the path cannot be derived from the service id the sweep already has.
    expect(await client(GS_FULL).missionCustomDir()).toBe(
      "/games/ni11558038_4/ftproot/dayzxb_missions/dayzOffline.enoch/custom",
    );
  });

  it("throws rather than composing a path with a hole in it", async () => {
    // ⚠️ Each missing field would otherwise yield a syntactically fine path
    // pointing somewhere real-looking and wrong — and uploadFile reports
    // success for a write into a directory the game never reads, which is the
    // silent failure this whole change exists to remove.
    for (const drop of ["username", "game"]) {
      const gs = structuredClone(GS_FULL) as any;
      delete gs.data.gameserver[drop];
      await expect(client(gs).missionCustomDir()).rejects.toThrow(new RegExp(drop, "i"));
    }
    const noMission = structuredClone(GS_FULL) as any;
    delete noMission.data.gameserver.settings.config.mission;
    await expect(client(noMission).missionCustomDir()).rejects.toThrow(/mission/i);
  });
});
