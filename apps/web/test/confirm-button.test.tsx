import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { confirmBlur, confirmExpire, confirmPress, type ConfirmPhase } from "../lib/confirm-press";
import { guardFormSubmit } from "../lib/submit-guard";
import { ARMED_CLASS, ConfirmButton, confirmButtonContent } from "../app/components/confirm-button";

const submitEvent = () => new Event("submit", { cancelable: true });

describe("confirmPress", () => {
  it("arms on the first press and sends nothing", () => expect(confirmPress("idle")).toEqual({ next: "armed", submit: false }));
  it("lets the second press submit", () => expect(confirmPress("armed")).toEqual({ next: "armed", submit: true }));
  it("sends nothing on a press while the post is in flight", () => expect(confirmPress("pending")).toEqual({ next: "pending", submit: false }));

  /** ⚠️ Review focus 1. */
  it("⚠️ a triple-tap posts once", () => {
    const form = new EventTarget();
    let phase: ConfirmPhase = "idle";
    let posts = 0;
    guardFormSubmit(form, new EventTarget(), (p) => { if (p) phase = "pending"; });
    for (let tap = 0; tap < 3; tap++) {
      const r = confirmPress(phase);
      phase = r.next;
      if (r.submit && form.dispatchEvent(submitEvent())) posts += 1;
    }
    expect(posts).toBe(1);
  });

  /** ⚠️ Review focus 1: React has not re-rendered yet, so tap three still reads "armed". */
  it("⚠️ a triple-tap posts once even with stale state — the form guard refuses the second POST", () => {
    const form = new EventTarget();
    let posts = 0;
    guardFormSubmit(form, new EventTarget(), () => {});
    for (const phase of ["idle", "armed", "armed"] as ConfirmPhase[]) {
      if (confirmPress(phase).submit && form.dispatchEvent(submitEvent())) posts += 1;
    }
    expect(posts).toBe(1);
  });

  it("disarms on blur and on expiry, but never un-sends", () => {
    expect(confirmBlur("armed")).toBe("idle");
    expect(confirmBlur("pending")).toBe("pending");
    expect(confirmExpire("armed")).toBe("idle");
    expect(confirmExpire("pending")).toBe("pending");
    expect(confirmExpire("idle")).toBe("idle");
  });
});

describe("ConfirmButton", () => {
  it("server-renders unarmed: the plain label, no hint, a real submit", () => {
    const html = renderToStaticMarkup(<form><ConfirmButton confirm="Press again to remove" className="btn">Remove</ConfirmButton></form>);
    expect(html).toContain('type="submit"');
    expect(html).toContain(">Remove</button>");
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("sr-only");
  });

  /** M4: armed must LOOK different, and not in rust — rust is an obligation, not "careful". */
  it("has an armed look in gold, never rust", () => {
    expect(ARMED_CLASS).toContain("border-gold");
    expect(ARMED_CLASS).not.toContain("rust");
  });
});

describe("confirmButtonContent (Task 13 fix round 1)", () => {
  /**
   * SSR only ever renders the idle phase, which is why the review finding
   * (RowAction's sr-only `who` span disappearing while armed) slipped past
   * the original tests. This exercises the armed branch directly, the way
   * RowAction now builds it: `confirm` plus the same who-span appended to
   * `children` in the idle case.
   */
  it("renders the confirm node's who span while armed", () => {
    const confirmNode = <>Press again to remove<span className="sr-only">{" Ada"}</span></>;
    const html = renderToStaticMarkup(<>{confirmButtonContent("armed", "Remove", confirmNode)}</>);
    expect(html).toContain("Press again to remove");
    expect(html).toContain('<span class="sr-only"> Ada</span>');
  });

  it("falls back to children when idle", () => {
    const html = renderToStaticMarkup(<>{confirmButtonContent("idle", "Remove", "Press again to remove")}</>);
    expect(html).toBe("Remove");
  });

  it("prefers the pending label while pending, when one is given", () => {
    const html = renderToStaticMarkup(<>{confirmButtonContent("pending", "Remove", "Press again to remove", "Removing…")}</>);
    expect(html).toBe("Removing…");
  });
});

describe("armed labels say what the second press does (M4)", () => {
  const dirs = ["clan", "base", "notifications"].map((d) => join(import.meta.dirname, "..", "app", "(site)", d));
  const sources = dirs.flatMap((d) => readdirSync(d, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx")).map((f) => readFileSync(join(d, f), "utf8")));
  const labels = sources.flatMap((s) => [...s.matchAll(/confirm="([^"]*)"/gu)].map((m) => m[1]!));
  it("finds them", () => expect(labels.length).toBeGreaterThan(8));
  it.each(labels)("%s starts with 'Press again to'", (label) => expect(label.startsWith("Press again to ")).toBe(true));
});
