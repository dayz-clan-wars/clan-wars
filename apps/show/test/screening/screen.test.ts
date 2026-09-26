import { describe, it, expect, vi } from "vitest";
import { MemoryScreeningStore } from "../../src/screening/store.js";
import { screenTexts } from "../../src/screening/screen.js";
import type { Moderate } from "../../src/screening/moderate.js";

const allowAll: Moderate = async (texts) => texts.map(() => ({ block: false, reason: "" }));

describe("screenTexts", () => {
  it("blocks blocklist hits without asking the moderator, and asks about the rest once", async () => {
    const moderate = vi.fn<Moderate>(allowAll);
    const store = new MemoryScreeningStore();
    const v = await screenTexts(["N4Z1 crew", "The Cocks", "The Cocks"], { store, moderate });
    expect(v.get("N4Z1 crew")).toMatchObject({ verdict: "block", source: "blocklist" });
    expect(v.get("The Cocks")).toEqual({ verdict: "allow", source: "llm", reason: null });
    expect(moderate).toHaveBeenCalledTimes(1);
    expect(moderate.mock.calls[0]![0]).toEqual(["The Cocks"]);
  });

  it("reuses cached verdicts and stores new ones", async () => {
    const store = new MemoryScreeningStore();
    await store.put("known", { verdict: "allow", source: "llm", reason: null });
    const moderate = vi.fn<Moderate>(allowAll);
    await screenTexts(["known", "fresh"], { store, moderate });
    expect(moderate.mock.calls[0]![0]).toEqual(["fresh"]);
    expect((await store.get(["fresh"])).get("fresh")!.source).toBe("llm");
  });

  it("an operator allow beats the blocklist", async () => {
    const store = new MemoryScreeningStore();
    await store.put("Aryanna", { verdict: "allow", source: "operator", reason: "a real name" });
    const v = await screenTexts(["Aryanna"], { store, moderate: allowAll });
    expect(v.get("Aryanna")!.verdict).toBe("allow");
  });

  it("re-asks about a cached blocklist verdict the blocklist no longer makes", async () => {
    const store = new MemoryScreeningStore();
    await store.put("Once Bad", { verdict: "block", source: "blocklist", reason: "old term" });
    const moderate = vi.fn<Moderate>(allowAll);
    const v = await screenTexts(["Once Bad"], { store, moderate });
    expect(v.get("Once Bad")!.verdict).toBe("allow");
  });

  it("⚠️ a moderator failure throws and stores nothing it did not rule on", async () => {
    const store = new MemoryScreeningStore();
    const moderate: Moderate = async () => { throw new Error("down"); };
    await expect(screenTexts(["a"], { store, moderate })).rejects.toThrow("down");
    expect((await store.get(["a"])).size).toBe(0);
  });
});
