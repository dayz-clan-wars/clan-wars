import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { RAID_WINDOW } from "../src/rules.js";

const here = dirname(fileURLToPath(import.meta.url));
const RUNBOOK = resolve(here, "..", "..", "..", "docs", "deploy", "raid-window.md");

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * ⚠️ Two statements of one fact. Nothing in code flips base damage — the
 * raid window is enforced by the game server's `cfggameplay.json`, by hand,
 * twice a week (spec §12) — so the runbook is the only place the window is
 * *done*, and `RAID_WINDOW` is the only place it is *stated*. This holds the
 * two together: the runbook must name both boundaries at 00:00 UTC with the
 * day names `RAID_WINDOW` gives, the key it edits, and the value each
 * boundary sets.
 */
describe("docs/deploy/raid-window.md matches RAID_WINDOW", () => {
  it("exists where spec §12 says it does", () => {
    expect(existsSync(RUNBOOK)).toBe(true);
  });

  const text = existsSync(RUNBOOK) ? readFileSync(RUNBOOK, "utf8") : "";

  it("names the opening boundary", () => {
    expect(text).toContain(`${DAY_NAMES[RAID_WINDOW.openDow]} 00:00 UTC`);
  });

  it("names the closing boundary", () => {
    expect(text).toContain(`${DAY_NAMES[RAID_WINDOW.closeDow]} 00:00 UTC`);
  });

  it("edits exactly the key spec §12 names, to both values", () => {
    expect(text).toContain("GeneralData.disableBaseDamage");
  });

  function tableRowFor(dow: number): string {
    const lines = text.split("\n");
    const line = lines.find(
      (l) => l.includes(`${DAY_NAMES[dow]} 00:00 UTC`) && l.trim().startsWith("|"),
    );
    if (!line) throw new Error(`no table row found for ${DAY_NAMES[dow]} 00:00 UTC`);
    return line;
  }

  it("sets disableBaseDamage to false at the opening boundary's table row", () => {
    expect(tableRowFor(RAID_WINDOW.openDow)).toContain("`false`");
  });

  it("sets disableBaseDamage to true at the closing boundary's table row", () => {
    expect(tableRowFor(RAID_WINDOW.closeDow)).toContain("`true`");
  });
});
