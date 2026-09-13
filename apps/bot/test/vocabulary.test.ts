import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(resolve(here, "..", "src", f), "utf8");

// packages/copy/src holds the outcome-copy tables both the site and the bot
// render (moved out of apps/web/lib/*-copy.ts on 2026-09-13) — every string
// literal there is player-facing exactly the same way, so it gets the same
// walk rather than a second, drifting copy of this check.
const COPY_SRC_ROOT = resolve(here, "..", "..", "..", "packages", "copy", "src");
const copySrc = (f: string) => readFileSync(join(COPY_SRC_ROOT, f), "utf8");
function listTsFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listTsFiles(join(dir, entry.name), rel);
    return entry.name.endsWith(".ts") ? [rel] : [];
  });
}
const COPY_FILES = listTsFiles(COPY_SRC_ROOT);

/**
 * The guide says "clan"; code says "faction". These modules are the ones
 * whose strings reach players (public embeds and DMs), so every string
 * literal in them must say clan. Identifiers may still say faction — the
 * check strips comments and looks inside quotes only.
 */
const PLAYER_FACING = [
  "feed-embed.ts", "ceremony-notify.ts", "dormancy-notify.ts", "notify.ts",
  // Increment 2c-b: the one reply every retired command gives.
  "retired-commands.ts",
  // Increment 3c: the clan_notices and war_log_events renderers.
  "notice-text.ts", "war-log-text.ts",
  // 2026-09-13: every slash command reply and embed.
  "commands/link.ts", "commands/base.ts", "commands/route.ts",
  "commands/embeds/link.ts", "commands/embeds/base.ts",
  // /guest's Discord-visible description text lives in the registry.
  "commands/index.ts",
];

const STRING_LITERALS = /(["'`])(?:\\.|(?!\1)[^\\])*\1/gsu;
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu;
// A package name is an identifier, not vocabulary: strip every import/export
// module specifier (including bare side-effect imports) before scanning, so
// "@factions/domain" and "@factions/db" don't count as player-facing text.
const MODULE_SPECIFIERS = /^\s*(?:import|export)\b[^;]*?\bfrom\s+["'][^"']+["'];?|^\s*import\s+["'][^"']+["'];?/gmu;
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
      const text = raw.replace(INTERPOLATION, "");
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

describe("packages/copy/src says clan, not faction", () => {
  // ⚠️ If COPY_SRC_ROOT moves, empties, or the .ts filter changes, this
  // loop's `for` iterates zero times and registers zero `it`s — the whole
  // describe block then reports green with nothing checked, and the guard
  // this file exists for goes silently dark. Asserting a specific known
  // file (not just a nonzero count) also catches a filter that admits
  // some-but-wrong files, e.g. a partial walk that still finds something.
  it("finds packages/copy/src's files, including clan.ts", () => {
    expect(COPY_FILES).toContain("clan.ts");
  });

  for (const file of COPY_FILES) {
    it(file, () => {
      expect(offendersIn(copySrc(file))).toEqual([]);
    });
  }
});
