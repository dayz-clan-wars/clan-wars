import { describe, it, expect } from "vitest";
import { RESTART_PERIOD_MS } from "@factions/domain";
import { historyInstants } from "../src/population.js";

describe("historyInstants", () => {
  // ⚠️ Strictly before: a window containing the current sample fires on every new record.
  it("stops strictly before the decision instant", () => {
    const d = new Date("2026-09-21T19:30:00Z");
    const xs = historyInstants(d, 3 * RESTART_PERIOD_MS);
    expect(xs.map((x) => x.toISOString())).toEqual([
      "2026-09-21T13:30:00.000Z", "2026-09-21T15:30:00.000Z", "2026-09-21T17:30:00.000Z",
    ]);
  });
});
