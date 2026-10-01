import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@factions/roster", () => ({
  liveFeed: vi.fn(async () => []),
  onlineNow: vi.fn(async () => [{ gamertag: "A", tag: null, connectedAt: new Date("2026-09-08T00:00:00Z") }]),
}));

const { GET } = await import("../app/api/live/[feed]/route");
const roster = await import("@factions/roster");
// Next 16: a route handler's second argument carries `params` as a Promise.
const call = (feed: string, qs = "") =>
  GET(new NextRequest(`http://x/api/live/${feed}${qs}`), { params: Promise.resolve({ feed }) });

describe("GET /api/live/[feed]", () => {
  it.each(["constructor", "foo", "__proto__"])("404s the unknown feed %s without touching the database", async (feed) => {
    const r = await call(feed);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "unknown-feed" });
    expect(roster.liveFeed).not.toHaveBeenCalled();
    expect(roster.onlineNow).not.toHaveBeenCalled();
  });
  it("drops junk cursors instead of passing them on", async () => {
    await call("kills", "?before=abc&after=-1");
    expect(roster.liveFeed).toHaveBeenLastCalledWith("kills", { before: undefined, after: undefined });
    await call("kills", "?before=1e309&after=0");
    expect(roster.liveFeed).toHaveBeenLastCalledWith("kills", { before: undefined, after: undefined });
  });
  it("passes a valid after cursor", async () => {
    await call("kills", "?after=42");
    expect(roster.liveFeed).toHaveBeenLastCalledWith("kills", { before: undefined, after: 42 });
  });
  it("passes a valid before cursor", async () => {
    const r = await call("war-log", "?before=7");
    expect(roster.liveFeed).toHaveBeenLastCalledWith("war-log", { before: 7, after: undefined });
    expect(await r.json()).toEqual({ items: [] });
  });
  it("serves the online list with ISO times and no-store", async () => {
    const r = await call("online");
    expect(r.headers.get("cache-control")).toBe("no-store, private");
    expect(await r.json()).toEqual({ players: [{ gamertag: "A", tag: null, connectedAt: "2026-09-08T00:00:00.000Z" }] });
  });
});
