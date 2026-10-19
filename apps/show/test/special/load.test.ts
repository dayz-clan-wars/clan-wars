import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSpecial, SPECIAL_SCRIPT_MAX } from "../../src/special/load.js";
import { parseDialogue } from "../../src/engine/audio/parseDialogue.js";

const REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../specials/2026-10-nasdara");

const META = {
  slug: "t", code: "Special", subtitle: "Start here", descriptionLead: "lead", facebookLines: ["fb"],
  cards: [{ header: "H", title: "T", rows: [{ name: "a", value: "1" }] }], marquee: ["m"], pronounce: [],
};

let dir: string;
function write(o: { script?: string; meta?: unknown; intro?: boolean; outro?: boolean } = {}) {
  fs.writeFileSync(path.join(dir, "script.txt"), o.script ?? "Boris: Hello.\nPavel: Hi.\n");
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(o.meta ?? META));
  if (o.intro !== false) fs.writeFileSync(path.join(dir, "intro.png"), "png");
  if (o.outro !== false) fs.writeFileSync(path.join(dir, "outro.png"), "png");
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "special-")); });

describe("loadSpecial", () => {
  it("loads the real special", () => {
    const s = loadSpecial(REAL);
    expect(s.code).toBe("Special");
    expect(s.slug).toBe("2026-10-nasdara");
    expect(s.narrative.length).toBeLessThanOrEqual(SPECIAL_SCRIPT_MAX);
    const lines = s.narrative.split("\n").filter((l) => l.trim());
    expect(parseDialogue(s.narrative)).toHaveLength(lines.length);
    expect(fs.existsSync(s.introPath)).toBe(true);
    expect(fs.existsSync(s.outroPath)).toBe(true);
  });

  it("loads a minimal fixture with the trailing newline trimmed", () => {
    write();
    expect(loadSpecial(dir).narrative).toBe("Boris: Hello.\nPavel: Hi.");
  });

  it("rejects a line that is not Boris:/Pavel:", () => {
    write({ script: "Boris: Hello.\n(Boris stands up)\n" });
    expect(() => loadSpecial(dir)).toThrow(/not a dialogue line/);
  });

  it("rejects an em or en dash in the script", () => {
    write({ script: "Boris: Hello — friend.\n" });
    expect(() => loadSpecial(dir)).toThrow(/dash/);
    write({ script: "Boris: Hello – friend.\n" });
    expect(() => loadSpecial(dir)).toThrow(/dash/);
  });

  it("rejects a script over SPECIAL_SCRIPT_MAX", () => {
    write({ script: `Boris: ${"a".repeat(SPECIAL_SCRIPT_MAX)}\n` });
    expect(() => loadSpecial(dir)).toThrow(/characters/);
  });

  it("rejects a missing intro.png", () => {
    write({ intro: false });
    expect(() => loadSpecial(dir)).toThrow(/intro.png/);
  });

  it("rejects meta with a code other than Special or an empty subtitle", () => {
    write({ meta: { ...META, code: "S01E09" } });
    expect(() => loadSpecial(dir)).toThrow(/code/);
    write({ meta: { ...META, subtitle: " " } });
    expect(() => loadSpecial(dir)).toThrow(/subtitle/);
  });
});
