import { describe, it, expect } from "vitest";
import { releaseEmbeds, EMBED_DESCRIPTION_MAX, type ReleaseNotes } from "../src/release-text.js";

const row = (over: Partial<ReleaseNotes> = {}): ReleaseNotes => ({
  version: "1.15.0",
  title: "automated base-zone enforcement",
  body: "### Added\n\n- A thing.\n",
  releasedAt: new Date("2026-09-15T00:00:00Z"),
  ...over,
});

describe("releaseEmbeds", () => {
  it("renders one embed for a body under the cap", () => {
    const embeds = releaseEmbeds(row());

    expect(embeds).toHaveLength(1);
    expect(embeds[0]!.title).toBe("v1.15.0 — automated base-zone enforcement");
    expect(embeds[0]!.description).toContain("- A thing.");
  });

  it("titles an untitled release with the bare version", () => {
    expect(releaseEmbeds(row({ title: null }))[0]!.title).toBe("v1.15.0");
  });

  it("does not number a single-embed release", () => {
    expect(releaseEmbeds(row())[0]!.footer).toBeUndefined();
  });

  it("splits a long body and numbers every piece", () => {
    const section = (n: number) => `### Section ${n}\n\n${"- a bullet of some length.\n".repeat(120)}`;
    const body = [section(1), section(2), section(3)].join("\n");
    expect(body.length).toBeGreaterThan(EMBED_DESCRIPTION_MAX);

    const embeds = releaseEmbeds(row({ body }));

    expect(embeds.length).toBeGreaterThan(1);
    expect(embeds.every((e) => (e.description ?? "").length <= EMBED_DESCRIPTION_MAX)).toBe(true);
    expect(embeds[0]!.footer?.text).toBe(`1/${embeds.length}`);
    expect(embeds.at(-1)!.footer?.text).toBe(`${embeds.length}/${embeds.length}`);
  });

  it("titles only the first piece, so a split release reads as one release", () => {
    const body = `### Section\n\n${"- a bullet of some length.\n".repeat(400)}`;

    const embeds = releaseEmbeds(row({ body }));

    expect(embeds.length).toBeGreaterThan(1);
    expect(embeds[0]!.title).toBe("v1.15.0 — automated base-zone enforcement");
    expect(embeds.slice(1).every((e) => e.title === undefined)).toBe(true);
  });

  it("splits a single oversized paragraph rather than dropping it", () => {
    // ⚠️ No markdown boundary to split on. Truncating here would lose release
    // notes silently, which is worse than an ugly break.
    const body = "x".repeat(EMBED_DESCRIPTION_MAX * 2 + 10);

    const embeds = releaseEmbeds(row({ body }));

    expect(embeds).toHaveLength(3);
    expect(embeds.map((e) => (e.description ?? "").length).reduce((a, b) => a + b, 0)).toBe(body.length);
  });
});
