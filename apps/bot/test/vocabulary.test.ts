import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(resolve(here, "..", "src", f), "utf8");

/**
 * The guide says "clan"; code says "faction". These four modules are the
 * ones whose strings reach players (public embeds and DMs), so every string
 * literal in them must say clan. Identifiers may still say faction — the
 * check strips comments and looks inside quotes only.
 */
const PLAYER_FACING = [
  "feed-embed.ts", "ceremony-notify.ts", "dormancy-notify.ts", "notify.ts",
  // Increment 2a: the claim and rebind command replies reach players too.
  // roster-commands.ts is retired whole in increment 2c and is not swept.
  "faction-commands.ts", "rebind-commands.ts",
];

const STRING_LITERALS = /(["'`])(?:\\.|(?!\1)[^\\])*\1/gsu;
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu;
// A package name is an identifier, not vocabulary: strip every import/export
// module specifier (including bare side-effect imports) before scanning, so
// "@factions/domain" and "@factions/db" don't count as player-facing text.
const MODULE_SPECIFIERS = /^\s*(?:import|export)\b[^;]*?\bfrom\s+["'][^"']+["'];?|^\s*import\s+["'][^"']+["'];?/gmu;
// A slash-command name is an identifier too: `/faction …` stays until the
// commands are retired (increment 2 of the target-state spec), and this
// exclusion goes with them.
const SLASH_COMMAND = /\/faction\b/gu;

describe("player-facing strings say clan, not faction", () => {
  for (const file of PLAYER_FACING) {
    it(file, () => {
      const code = src(file).replace(COMMENTS, "").replace(MODULE_SPECIFIERS, "");
      const offenders = [...code.matchAll(STRING_LITERALS)]
        .map((m) => m[0])
        .filter((s) => /faction/iu.test(s.replace(SLASH_COMMAND, "")));
      expect(offenders).toEqual([]);
    });
  }
});
