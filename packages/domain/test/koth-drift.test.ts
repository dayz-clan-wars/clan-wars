import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { KOTH_LOCATIONS, KOTH_PRESET_FILES } from "../src/index.js";

// ⚠️ Two statements of one fact (CLAUDE.md): the chernarus repo holds the spawn
// groups and the presets; this package vendors them. Skipped where the sibling
// checkout is absent (CI), enforced wherever it is present. It reads that
// checkout's WORKING TREE: if it fails on presets you have not pulled yet,
// `git -C ../chernarus pull` (never commit there; it is someone's working copy).
const CHERNARUS = join(__dirname, "../../../../chernarus");
const present = existsSync(join(CHERNARUS, "cfgplayerspawnpoints.xml"));

function freshGroups(): Map<string, [number, number][]> {
  const xml = readFileSync(join(CHERNARUS, "cfgplayerspawnpoints.xml"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const fresh = xml.split("<fresh>")[1]!.split("</fresh>")[0]!;
  return new Map([...fresh.matchAll(/<group name="([^"]+)">([\s\S]*?)<\/group>/g)].map(([, name, body]) =>
    [name!, [...body!.matchAll(/<pos x="([\d.]+)" z="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])] as [number, number])]));
}

describe.skipIf(!present)("KotH catalogue vs the chernarus repo", () => {
  it("the 31 towns are exactly the <fresh> spawn groups", () => {
    expect(KOTH_LOCATIONS.map((l) => l.spawnGroup).sort()).toEqual([...freshGroups().keys()].sort());
  });
  it("each centre is the mean of its group's spawn spots", () => {
    const groups = freshGroups();
    for (const l of KOTH_LOCATIONS) {
      const pos = groups.get(l.spawnGroup)!;
      expect([l.centreX, l.centreZ]).toEqual([
        Math.round(pos.reduce((s, p) => s + p[0], 0) / pos.length),
        Math.round(pos.reduce((s, p) => s + p[1], 0) / pos.length),
      ]);
    }
  });
  it("presets match custom/koth-*.json", () => {
    const names = readdirSync(join(CHERNARUS, "custom")).filter((f) => f.startsWith("koth-") && f.endsWith(".json")).sort();
    expect([...KOTH_PRESET_FILES].sort()).toEqual(names.map((n) => `./custom/${n}`));
  });
});
