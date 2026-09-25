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
    t.hold("pointer");
    vi.advanceTimersByTime(60_000);
    expect(gone).not.toHaveBeenCalled();
    t.release("pointer");
    vi.advanceTimersByTime(999);
    expect(gone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("a new pick while held does not start a countdown under the pointer", () => {
    const gone = vi.fn();
    const t = dismissTimer(1000, gone);
    t.hold("pointer");
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

  // F1(b): the pointer and keyboard focus are independent holds — a mouse
  // graze away from a keyboard-focused Undo must not resume the countdown.
  it("pointer leaves while focus still holds: no expiry", () => {
    const gone = vi.fn();
    const t = dismissTimer(1000, gone);
    t.start();
    t.hold("pointer");
    t.hold("focus");
    t.release("pointer");
    vi.advanceTimersByTime(5000);
    expect(gone).not.toHaveBeenCalled();
  });

  it("expires only once BOTH pointer and focus release", () => {
    const gone = vi.fn();
    const t = dismissTimer(1000, gone);
    t.start();
    t.hold("pointer");
    t.hold("focus");
    t.release("pointer");
    t.release("focus");
    vi.advanceTimersByTime(999);
    expect(gone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  // F1(a): a bar that unmounts while still "held" (e.g. a refusal replaces
  // the toast before onMouseLeave/onBlur ever fires) must not leave the
  // countdown wedged for every later toast. `cancel` is the release path an
  // unmounting bar takes: it clears whatever holds it left behind so the
  // next `start()` counts down normally.
  it("cancel clears a hold left behind by an unmounted bar; the next start counts down", () => {
    const gone = vi.fn();
    const t = dismissTimer(1000, gone);
    t.hold("pointer");
    t.cancel();
    t.start();
    vi.advanceTimersByTime(999);
    expect(gone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(gone).toHaveBeenCalledTimes(1);
  });
});
