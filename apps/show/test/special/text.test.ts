import { describe, it, expect } from "vitest";
import { specialDraftMessage, specialFacebookCaption, specialMarker } from "../../src/special/text.js";

describe("special text", () => {
  it("the marker is in its own namespace, never a weekly draft marker", () => {
    const m = specialMarker("2026-10-nasdara", "Boris: Hi.");
    expect(m.startsWith("show:special:2026-10-nasdara:")).toBe(true);
    expect(/^show:\d{4}-\d{2}-\d{2}:/.test(m)).toBe(false);
    expect(specialMarker("2026-10-nasdara", "Boris: Hello.")).not.toBe(m);
  });

  it("the draft links the unlisted video, asks for a reaction and carries the marker", () => {
    const msg = specialDraftMessage({ subtitle: "New to Clan Wars? Start here", youtubeVideoId: "vid1", narrative: "Boris: Hi — there.", marker: "show:special:x:abc" });
    expect(msg.content).toContain("https://youtu.be/vid1");
    expect(msg.content).toContain("React ✅ to publish or ❌ to reject");
    expect(msg.content).toContain("Clan Wars Special · New to Clan Wars? Start here");
    expect(msg.content).toContain("show:special:x:abc");
    expect(msg.files?.[0]?.data.toString()).not.toContain("—");
  });

  it("the Facebook caption", () => {
    const c = specialFacebookCaption({ subtitle: "New to Clan Wars? Start here", lines: ["Clan Wars moved — to Nasdara."], youtubeVideoId: "vid1", discordInvite: "discord.gg/TJu4XP25nr" });
    expect(c.startsWith("\u{1F399}\u{FE0F} The Bloodbag and Painkiller Show: Clan Wars Special · New to Clan Wars? Start here")).toBe(true);
    expect(c).toContain("https://youtu.be/vid1");
    expect(c).toContain("https://discord.gg/TJu4XP25nr");
    expect(c).not.toContain("—");
  });
});
