import { describe, it, expect } from "vitest";
import { buildVideoMeta, videoTitle, YOUTUBE_DESCRIPTION_MAX } from "../../../src/engine/publish/youtube/buildVideoMeta.js";

describe("buildVideoMeta", () => {
  it("titles per spec §2.4 with a middle dot", () => {
    expect(videoTitle("S01E03", "The Curse")).toBe("The Bloodbag and Painkiller Show: Clan Wars S01E03 · The Curse");
  });
  it("keeps the title within YouTube's 100 characters by shortening the subtitle", () => {
    const t = videoTitle("S01E03", "x".repeat(80));
    expect(t.length).toBeLessThanOrEqual(100);
    expect(t.startsWith("The Bloodbag and Painkiller Show: Clan Wars S01E03 · ")).toBe(true);
  });
  it("strips markdown and the angle brackets YouTube refuses", () => {
    const m = buildVideoMeta({ code: "S01E03", subtitle: "A <b> C", transcript: "**BORIS**: `SNA` <3 _you_" });
    expect(m.title).not.toMatch(/[<>]/u);
    expect(m.description).toBe("BORIS: SNA 3 you");
  });
  it("caps the description at 5,000 characters with a notice", () => {
    const m = buildVideoMeta({ code: "S01E03", subtitle: "T", transcript: "a".repeat(9000) });
    expect(m.description.length).toBe(YOUTUBE_DESCRIPTION_MAX);
    expect(m.description.endsWith("[transcript truncated]")).toBe(true);
  });
});
