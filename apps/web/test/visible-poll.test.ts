import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visiblePoll } from "../lib/visible-poll";

class FakeDoc extends EventTarget { hidden = false; }
const flip = (doc: FakeDoc, hidden: boolean) => { doc.hidden = hidden; doc.dispatchEvent(new Event("visibilitychange")); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("visiblePoll (L9)", () => {
  it("polls on its interval while the tab is visible", () => {
    const run = vi.fn();
    visiblePoll(new FakeDoc(), run, 1000);
    vi.advanceTimersByTime(3000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("⚠️ stops while the tab is hidden, and catches up at once on return", () => {
    const run = vi.fn();
    const doc = new FakeDoc();
    visiblePoll(doc, run, 1000);
    flip(doc, true);
    vi.advanceTimersByTime(60_000);
    expect(run).not.toHaveBeenCalled();
    flip(doc, false);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("starts paused in a tab that opened in the background", () => {
    const run = vi.fn();
    const doc = new FakeDoc();
    doc.hidden = true;
    visiblePoll(doc, run, 1000);
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
  });

  it("stops for good once disposed", () => {
    const run = vi.fn();
    const doc = new FakeDoc();
    visiblePoll(doc, run, 1000)();
    flip(doc, false);
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the pages that poll use it", () => {
  const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "app", "(site)", ...p), "utf8");
  it.each([["kit", "kit-flow.tsx"], ["link", "link-flow.tsx"]])("%s/%s", (...p) => {
    const text = read(...p);
    expect(text).toContain("visiblePoll(document,");
    expect(text).not.toMatch(/setInterval\(\(\) => \{ void refresh\(\); \}/u);
  });
});

describe("the hero's clan read runs beside the page's own (L9)", () => {
  const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "app", "(site)", "clan", ...p), "utf8");
  it.each([["vault", "page.tsx"], ["board", "page.tsx"], ["board", "[board]", "page.tsx"]])("%s", (...p) => {
    expect(read(...p)).toMatch(/await Promise\.all\(\[[^\]]*clanFor\(session\.sub\)\]\)/u);
  });
});
