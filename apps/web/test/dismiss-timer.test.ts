import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dismissTimer, UNDO_MS } from "../lib/dismiss-timer";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("the Undo bar's clock (M9)", () => {
  it("gives at least ten seconds (WCAG 2.2.1; it was 4.5)", () => expect(UNDO_MS).toBeGreaterThanOrEqual(10_000));

  it("expires after its time", () => {
    const gone = vi.fn();
    dismissTimer(1000, gone).start();
    vi.advanceTimersByTime(999);
    expect(gone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("never expires while held, and restarts the full time on release", () => {
    const gone = vi.fn();
    const t = dismissTimer(1000, gone);
    t.start();
    vi.advanceTimersByTime(900);
    t.hold();
    vi.advanceTimersByTime(60_000);
    expect(gone).not.toHaveBeenCalled();
    t.release();
    vi.advanceTimersByTime(999);
    expect(gone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("a new pick while held does not start a countdown under the pointer", () => {
    const gone = vi.fn();
    const t = dismissTimer(1000, gone);
    t.hold();
    t.start();
    vi.advanceTimersByTime(5000);
    expect(gone).not.toHaveBeenCalled();
  });

  it("a new start replaces the old countdown; cancel stops it", () => {
    const gone = vi.fn();
    const t = dismissTimer(1000, gone);
    t.start();
    vi.advanceTimersByTime(800);
    t.start();
    vi.advanceTimersByTime(800);
    expect(gone).not.toHaveBeenCalled();
    t.cancel();
    vi.advanceTimersByTime(5000);
    expect(gone).not.toHaveBeenCalled();
  });
});
