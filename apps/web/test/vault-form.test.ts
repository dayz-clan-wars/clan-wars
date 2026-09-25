import { describe, it, expect } from "vitest";
import { editingIdFor } from "../lib/vault-form";

const LOCKS = [{ id: 5 }, { id: 9 }];

describe("editingIdFor (M11 review fix, round 1)", () => {
  /**
   * ⚠️ LockEditor only renders under `officer` on the page. Without this gate,
   * an officer demoted between page load and submit, or a crafted
   * `?result=edit.gone&kept.lock=<visible id>` from a non-officer, would pick
   * an id here — suppressing the top notice — with no editor rendered to show
   * the refusal in. It must return null whenever `officer` is false.
   */
  it("is null when the viewer is not an officer, even with a visible lock and a refusal", () => {
    expect(editingIdFor(false, true, "5", LOCKS)).toBeNull();
  });

  it("is the lock's id when the viewer is an officer and the lock is visible", () => {
    expect(editingIdFor(true, true, "5", LOCKS)).toBe(5);
  });

  it("is null when nothing was refused", () => {
    expect(editingIdFor(true, false, "5", LOCKS)).toBeNull();
  });

  it("is null when the lock param is missing", () => {
    expect(editingIdFor(true, true, undefined, LOCKS)).toBeNull();
  });

  it("is null when the lock has since gone (deleted by another officer)", () => {
    expect(editingIdFor(true, true, "404", LOCKS)).toBeNull();
  });
});
