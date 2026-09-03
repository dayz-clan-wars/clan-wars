import { describe, it, expect } from "vitest";
import { feedEmbed, flagLabel } from "../src/feed-embed.js";
import type { QueuedFactionEvent } from "../src/feed-store.js";

const at = new Date("2026-09-01T21:30:07Z");
const base = { name: "Wolf Tang Clan", tag: "WTC", texture: "Flag_Wolf" };
const ev = (kind: QueuedFactionEvent["kind"], payload: Record<string, unknown> = {}): QueuedFactionEvent =>
  ({ id: 1, kind, occurredAt: at, payload: { ...base, ...payload } as QueuedFactionEvent["payload"] });

describe("feedEmbed", () => {
  it("titles every embed with name and tag", () => {
    expect(feedEmbed(ev("founded")).title).toBe("Wolf Tang Clan [WTC]");
  });

  it("⚠️ timestamps from the transition, not from now", () => {
    // The backfill inserts foundings days in the past; without this they
    // would all read as having just happened.
    expect(feedEmbed(ev("founded")).timestamp).toBe(at.toISOString());
  });

  it("names the actor when there is one", () => {
    expect(feedEmbed(ev("founded", { actor: "SubatomicRacer" })).description)
      .toContain("SubatomicRacer");
  });

  it("omits the actor clause entirely when unlinked", () => {
    const d = feedEmbed(ev("founded")).description!;
    expect(d).not.toContain("undefined");
    expect(d).not.toContain(" by ");
  });

  it("shows the previous name on a rename", () => {
    const d = feedEmbed(ev("renamed", { previousName: "The Nest", actor: "Racer" })).description!;
    expect(d).toContain("The Nest");
    expect(d).toContain("Wolf Tang Clan");
  });

  it("renders the disband deadline on a dormancy post as a relative timestamp", () => {
    const disbandAt = "2026-09-15T21:30:07.000Z";
    const d = feedEmbed(ev("dormant", { disbandAt })).description!;
    expect(d).toContain(`<t:${Math.floor(Date.parse(disbandAt) / 1000)}:R>`);
  });

  it("⚠️ names no protagonist on the clock-driven kinds", () => {
    // A clock did it. Naming whoever happened to be leader would blame them
    // for the faction dying.
    for (const kind of ["dormant", "revived", "disbanded"] as const) {
      expect(feedEmbed(ev(kind, { actor: "Racer" })).description).not.toContain("Racer");
    }
  });

  it("gives each kind a distinct colour band", () => {
    const colour = (k: QueuedFactionEvent["kind"]) => feedEmbed(ev(k)).color;
    expect(colour("founded")).toBe(colour("activated"));
    expect(colour("founded")).not.toBe(colour("disbanded"));
    expect(colour("dormant")).not.toBe(colour("disbanded"));
    expect(colour("renamed")).toBe(colour("rebound"));
  });

  it("names the flag as a field, stripped of its prefix", () => {
    expect(flagLabel("Flag_Wolf")).toBe("Wolf");
    expect(feedEmbed(ev("founded")).fields).toEqual([{ name: "Flag", value: "Wolf", inline: true }]);
  });

  it("has no thumbnail without a resolver, and one with", () => {
    expect(feedEmbed(ev("founded")).thumbnail).toBeUndefined();
    const withImage = feedEmbed(ev("founded"), (t) => `https://x/${t}.png`);
    expect(withImage.thumbnail).toEqual({ url: "https://x/Flag_Wolf.png" });
  });

  it("⚠️ never renders a coordinate even if one reached the payload", () => {
    // Defence in depth behind faction_events_no_coordinates: the embed reads
    // named fields only, so an unexpected key cannot be printed by accident.
    const rendered = JSON.stringify(feedEmbed(ev("founded", { poleKey: "1:2:3" })));
    expect(rendered).not.toContain("1:2:3");
  });

  it("covers every kind", () => {
    for (const kind of ["founded", "activated", "renamed", "rebound", "dormant", "revived", "disbanded"] as const) {
      const e = feedEmbed(ev(kind, { previousName: "Old", disbandAt: "2026-09-15T00:00:00.000Z" }));
      expect(e.description).toBeTruthy();
      expect(e.color).toBeTypeOf("number");
    }
  });

  it("falls back to the deadline-less sentence when disbandAt is not parseable", () => {
    const d = feedEmbed(ev("dormant", { disbandAt: "not-a-date" })).description!;
    expect(d).not.toContain("<t:");
    expect(d).not.toContain("NaN");
  });
});
