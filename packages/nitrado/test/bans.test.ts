import { describe, it, expect, vi } from "vitest";
import { NitradoClient } from "../src/client.js";

/**
 * Fakes the settings GET/POST pair. `posts` records every POST body so a
 * test can assert exactly-one-write (or zero) — the whole point of the
 * batched methods under test.
 */
function fakeSettings(bans: string) {
  const posts: { category: string; key: string; value: string }[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      return { ok: true, json: async () => ({ status: "success" }) } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({ status: "success", data: { settings: { general: { bans } } } }),
    } as unknown as Response;
  });
  return { fetchFn, posts };
}

describe("NitradoClient.getBans", () => {
  it("splits the \\r\\n-joined field and drops blanks", async () => {
    const { fetchFn } = fakeSettings("ABC123\r\n\r\nRonald\r\n  ");
    const client = new NitradoClient("t", 1, fetchFn as unknown as typeof fetch);
    await expect(client.getBans()).resolves.toEqual(["ABC123", "Ronald"]);
  });

  it("returns an empty list when the field is absent", async () => {
    const { fetchFn } = fakeSettings("");
    const client = new NitradoClient("t", 1, fetchFn as unknown as typeof fetch);
    await expect(client.getBans()).resolves.toEqual([]);
  });
});

describe("NitradoClient.addBans", () => {
  it("writes both entries in ONE read-modify-write", async () => {
    const { fetchFn, posts } = fakeSettings("existing");
    const client = new NitradoClient("t", 1, fetchFn as unknown as typeof fetch);
    await client.addBans(["ABC123", "Ronald"]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.value).toBe("existing\r\nABC123\r\nRonald");
  });

  it("skips entries already present and does not duplicate", async () => {
    const { fetchFn, posts } = fakeSettings("ABC123");
    const client = new NitradoClient("t", 1, fetchFn as unknown as typeof fetch);
    await client.addBans(["ABC123", "Ronald"]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.value).toBe("ABC123\r\nRonald");
  });

  it("issues NO post when every entry is already present", async () => {
    const { fetchFn, posts } = fakeSettings("ABC123\r\nRonald");
    const client = new NitradoClient("t", 1, fetchFn as unknown as typeof fetch);
    await client.addBans(["ABC123", "Ronald"]);
    expect(posts).toHaveLength(0);
  });

  it("drops blank and whitespace-only names", async () => {
    const { fetchFn, posts } = fakeSettings("existing");
    const client = new NitradoClient("t", 1, fetchFn as unknown as typeof fetch);
    await client.addBans(["  ", "", "ABC123"]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.value).toBe("existing\r\nABC123");
  });

  it("deduplicates within its own input", async () => {
    const { fetchFn, posts } = fakeSettings("existing");
    const client = new NitradoClient("t", 1, fetchFn as unknown as typeof fetch);
    await client.addBans(["ABC123", "ABC123"]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.value).toBe("existing\r\nABC123");
  });

  it("issues NO post when input is empty after trimming", async () => {
    const { fetchFn, posts } = fakeSettings("existing");
    const client = new NitradoClient("t", 1, fetchFn as unknown as typeof fetch);
    await client.addBans(["  ", ""]);
    expect(posts).toHaveLength(0);
  });
});

describe("NitradoClient.removeBans", () => {
  it("removes both entries in ONE read-modify-write", async () => {
    const { fetchFn, posts } = fakeSettings("ABC123\r\nRonald\r\nKeep");
    const client = new NitradoClient("t", 1, fetchFn as unknown as typeof fetch);
    await client.removeBans(["ABC123", "Ronald"]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.value).toBe("Keep");
  });

  it("issues NO post when nothing was present", async () => {
    const { fetchFn, posts } = fakeSettings("Keep");
    const client = new NitradoClient("t", 1, fetchFn as unknown as typeof fetch);
    await client.removeBans(["ABC123", "Ronald"]);
    expect(posts).toHaveLength(0);
  });

  it("issues NO post when input is empty after trimming", async () => {
    const { fetchFn, posts } = fakeSettings("Keep");
    const client = new NitradoClient("t", 1, fetchFn as unknown as typeof fetch);
    await client.removeBans(["  ", ""]);
    expect(posts).toHaveLength(0);
  });
});
