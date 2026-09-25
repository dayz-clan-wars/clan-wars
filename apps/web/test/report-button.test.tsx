import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { reportFocusAfter } from "../lib/report-focus";
import { ReportButton } from "../app/(site)/base/report-button";

const PARTS = [{ dayzId: "a", gamertag: "Ada" }, { dayzId: "b", gamertag: "Bo" }];

describe("reportFocusAfter (H4)", () => {
  it("moves focus to Confirm when the button arms — the pressed button has just unmounted", () => expect(reportFocusAfter("idle", "armed")).toBe("confirm"));
  it("returns focus to Press charges on Cancel or timeout", () => expect(reportFocusAfter("armed", "idle")).toBe("press"));
  it("moves focus to the result when charges are pressed", () => expect(reportFocusAfter("armed", "done")).toBe("status"));
  it("does nothing on first render or without a change", () => {
    expect(reportFocusAfter("idle", "idle")).toBeNull();
    expect(reportFocusAfter("armed", "armed")).toBeNull();
  });
});

describe("the report button", () => {
  const html = renderToStaticMarkup(<ReportButton incidentId={1} participants={PARTS} minTermLabel="3 days" />);

  /** H4: a live region inserted with its content is announced unreliably; this one is there from the start. */
  it("renders its live region before anything happens", () => expect(html).toContain('role="status"'));

  it("L3: charge boxes are the site's checkbox, on 44px rows", () => {
    expect(html).toContain("h-5 w-5");
    expect(html.match(/min-h-\[44px\] items-center gap-3/gu) ?? []).toHaveLength(2);
  });

  it("L1: nothing on it is rust text — a refusal is not an obligation", () => expect(html).not.toContain("text-rust-2"));
});
