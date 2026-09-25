import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROSTER_COOLDOWN_MS } from "@factions/domain";
import { TABLES } from "@factions/copy";
import { days } from "../lib/format";
import { LeaveForm } from "../app/(site)/clan/leave-form";

/**
 * L2: the box said "for a while"; the success message then said the number.
 * Two statements of one fact — this holds them together.
 */
describe("Leave", () => {
  it("names the cooldown before the player commits", () => {
    expect(renderToStaticMarkup(<LeaveForm />)).toContain(`I understand I cannot join a clan again for ${days(ROSTER_COOLDOWN_MS)} after leaving.`);
  });
  it("in the same words the success message uses", () => {
    expect(TABLES.leave.ok).toContain(days(ROSTER_COOLDOWN_MS));
  });
});
