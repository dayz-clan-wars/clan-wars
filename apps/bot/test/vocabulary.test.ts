import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(resolve(here, "..", "src", f), "utf8");

/**
 * The guide says "clan"; code says "faction". These modules are the ones
 * whose strings reach players (public embeds and DMs), so every string
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
// A template literal's `${…}` holds code, not copy — e.g. `${faction.name}`
// interpolates an identifier, and the raw literal text (backtick to
// backtick) includes it verbatim, so it must be stripped before judging
// whether the literal's actual prose says "faction".
const INTERPOLATION = /\$\{[^}]*\}/gu;
// Whitespace or sentence punctuation marks a literal as prose: a bare
// kebab-case or single-word token (a discriminant like "no-faction", a
// status tag, an id) is an identifier hiding in quotes, not text a player
// reads, and renaming it is a cross-file, behaviour-bearing change this
// sweep does not make.
const PROSE_SHAPE = /[\s.,!?:;]/u;

/**
 * The literals in `code` that say "faction" where a player-facing sentence
 * should say "clan" — comments, module specifiers, interpolated code inside
 * template literals, and bare identifier-shaped literals are not counted.
 */
export function offendersIn(code: string): string[] {
  const stripped = code.replace(COMMENTS, "").replace(MODULE_SPECIFIERS, "");
  return [...stripped.matchAll(STRING_LITERALS)]
    .map((m) => m[0])
    .filter((raw) => {
      const text = raw.replace(INTERPOLATION, "").replace(SLASH_COMMAND, "");
      return /faction/iu.test(text) && PROSE_SHAPE.test(text);
    });
}

describe("offendersIn", () => {
  it("does not flag a discriminant tag compared by ===", () => {
    expect(offendersIn('x === "no-faction"')).toEqual([]);
  });

  it("does not flag an interpolated identifier", () => {
    expect(offendersIn("`Your ${faction.name} is live`")).toEqual([]);
  });

  it("flags a player-facing sentence that still says faction", () => {
    expect(offendersIn('"another faction holds it"')).toEqual(['"another faction holds it"']);
  });
});

describe("player-facing strings say clan, not faction", () => {
  for (const file of PLAYER_FACING) {
    it(file, () => {
      expect(offendersIn(src(file))).toEqual([]);
    });
  }
});
