import { describe, it, expect, vi } from "vitest";
import { readJson, resolveTyped, type Match } from "../lib/link-claim";

const RONALD: Match = { dayzId: "dz-1", gamertag: "RonaldRaygun552" };

describe("resolveTyped (H5)", () => {
  it("answers from the list on screen when it was fetched for exactly what is typed", async () => {
    const search = vi.fn();
    expect(await resolveTyped("ronaldraygun552 ", { q: "ronaldraygun552", matches: [RONALD] }, search)).toEqual({ kind: "found", dayzId: "dz-1" });
    expect(search).not.toHaveBeenCalled();
  });

  /** ⚠️ The race: the whole gamertag typed, "Claim it" tapped, before the 200 ms debounce fetched. */
  it("⚠️ searches again when the list on screen is for older text", async () => {
    const search = vi.fn(async () => [RONALD]);
    expect(await resolveTyped("RonaldRaygun552", { q: "Ronald", matches: [] }, search)).toEqual({ kind: "found", dayzId: "dz-1" });
    expect(search).toHaveBeenCalledWith("RonaldRaygun552");
  });

  it("is unseen only when a search for exactly this text has no exact match", async () => {
    expect(await resolveTyped("Nobody", { q: "", matches: [] }, async () => [RONALD])).toEqual({ kind: "unseen" });
  });

  it("is a failure, not a denial, when the search itself fails", async () => {
    expect(await resolveTyped("RonaldRaygun552", { q: "", matches: [] }, async () => null)).toEqual({ kind: "failed" });
  });
});

describe("readJson (M1)", () => {
  it("returns the body of a JSON 200", async () => {
    expect(await readJson<{ a: number }>(new Response(JSON.stringify({ a: 1 }), { status: 200 }))).toEqual({ a: 1 });
  });
  it("is null for no response, a 500, and an HTML 200 (a lapsed session's login page)", async () => {
    expect(await readJson(null)).toBeNull();
    expect(await readJson(new Response("oops", { status: 500 }))).toBeNull();
    expect(await readJson(new Response("<!doctype html><title>Sign in</title>", { status: 200 }))).toBeNull();
  });
});
