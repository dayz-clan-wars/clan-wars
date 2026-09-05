import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Frontend rebuild §4 and §6. The palette used to be stated twice, in two
 * scope-isolated CSS modules, and `palette-drift.test.ts` caught the two
 * disagreeing. Under `@theme` it is stated once — so the drift that test
 * caught can no longer be expressed, and this test guards the new failure
 * mode instead: ⚠️ a token dropped during a port is silent. One screen
 * renders in a browser default and looks merely plain.
 */
const TOKENS: Record<string, string> = {
  "--color-ink": "#e8e2d4",
  "--color-ink-2": "#b5afa4",
  "--color-muted": "#8a857c",
  "--color-dim": "#6e6a62",
  "--color-frame": "#0b0b0a",
  "--color-surface": "#131211",
  "--color-rule": "#1a1917",
  "--color-rule-2": "#2a2825",
  "--color-gold": "#d9a03c",
  "--color-rust": "#8c3a22",
  "--color-olive": "#8fa36a",
  "--color-terrain": "#111110",
  "--color-ground": "#050505",
};

const FACES = ["--font-display", "--font-sans", "--font-mono"];

describe("the @theme block carries the whole palette", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "app", "globals.css"), "utf8");
  const theme = css.match(/@theme\s*\{([\s\S]*?)\n\}/u)?.[1] ?? "";

  it("has a @theme block", () => {
    expect(theme).not.toBe("");
  });

  it.each(Object.entries(TOKENS))("declares %s as %s", (token, value) => {
    expect(theme).toMatch(new RegExp(`${token}\\s*:\\s*${value}\\s*;`, "u"));
  });

  it.each(FACES)("declares %s", (face) => {
    expect(theme).toMatch(new RegExp(`${face}\\s*:`, "u"));
  });

  it("⚠️ states the palette exactly once — no second declaration of --color-gold in globals.css", () => {
    // The whole point of @theme. A second `--color-gold:` in this stylesheet
    // is the two-statements drift coming back.
    const goldDecls = css.match(/--color-gold\s*:/gu) ?? [];
    expect(goldDecls).toHaveLength(1);
  });
});
