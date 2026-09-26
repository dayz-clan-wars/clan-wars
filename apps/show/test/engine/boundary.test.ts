import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Spec §3: `src/engine/` takes plain data and returns files. It never imports the Clan Wars
// schema or the Clan Wars side of apps/show, and never reads the environment (config
// arrives as parameters), so the ported code stays testable with injected fakes.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const ENGINE = path.join(SRC, "engine");
const FORBIDDEN_DIRS = ["story", "cards", "stores", "produce", "screening", "prompt", "script"].map((d) => path.join(SRC, d));

function engineFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return engineFiles(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}

const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function specifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) out.push((m[1] ?? m[2])!);
  return out;
}

describe("engine boundary", () => {
  const files = engineFiles(ENGINE);

  it("finds the engine files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => [path.relative(SRC, f), f]))("%s imports nothing Clan Wars specific", (_rel, file) => {
    const code = stripComments(fs.readFileSync(file, "utf8"));
    for (const spec of specifiers(code)) {
      expect(spec.startsWith("@factions/"), `${spec}`).toBe(false);
      if (spec.startsWith(".")) {
        const target = path.resolve(path.dirname(file), spec);
        for (const dir of FORBIDDEN_DIRS) expect(target.startsWith(dir + path.sep) || target === dir, `${spec}`).toBe(false);
      }
    }
  });

  it.each(files.map((f) => [path.relative(SRC, f), f]))("%s never reads process.env", (_rel, file) => {
    expect(stripComments(fs.readFileSync(file, "utf8"))).not.toMatch(/process\.env/);
  });

  it("the checks catch a violation", () => {
    expect(specifiers(`import { x } from "@factions/db";`)).toEqual(["@factions/db"]);
    expect(specifiers(`import type { S } from "../../story/types.js";`)).toEqual(["../../story/types.js"]);
    expect(stripComments(`// process.env.X\nconst a = 1;`)).not.toMatch(/process\.env/);
    expect(stripComments(`const u = "http://x"; const e = process.env.Y;`)).toMatch(/process\.env/);
  });
});
