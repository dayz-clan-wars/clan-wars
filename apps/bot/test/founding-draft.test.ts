import { describe, it, expect } from "vitest";
import { putDraft, getDraft, clearDraft, DRAFT_TTL_MS } from "../src/commands/founding-draft.js";

const t0 = new Date("2026-09-13T00:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

describe("founding drafts", () => {
  it("keeps one draft per actor", () => {
    putDraft("111", { ceremonyId: 1, texture: null, memberDayzIds: ["a"] }, t0);
    putDraft("222", { ceremonyId: 2, texture: "Zenit", memberDayzIds: ["b"] }, t0);
    expect(getDraft("111", t0)!.ceremonyId).toBe(1);
    expect(getDraft("222", t0)!.texture).toBe("Zenit");
  });

  /** R4: a stale draft is worse than none — it would found a clan from a ceremony that has since expired. */
  it("forgets a draft older than the TTL", () => {
    putDraft("111", { ceremonyId: 1, texture: null, memberDayzIds: [] }, t0);
    expect(getDraft("111", at(DRAFT_TTL_MS - 1))).not.toBeNull();
    expect(getDraft("111", at(DRAFT_TTL_MS + 1))).toBeNull();
  });

  it("clears on demand, so a founded clan cannot be founded twice from one draft", () => {
    putDraft("111", { ceremonyId: 1, texture: null, memberDayzIds: [] }, t0);
    clearDraft("111");
    expect(getDraft("111", t0)).toBeNull();
  });
});
