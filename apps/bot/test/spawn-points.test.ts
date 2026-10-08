import { describe, it, expect } from "vitest";
import { narrowFreshSpawns } from "../src/spawn-points.js";

const SPAWNS = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<playerspawnpoints>
    <fresh>
        <spawn_params>
            <min_dist_player>65</min_dist_player>
        </spawn_params>
        <generator_posbubbles>
            <group name="Balota">
                <pos x="4491.000000" z="2312.000000" />
            </group>
            <!-- <group name="Berezino"><pos x="1.000000" z="1.000000" /></group> -->
            <group name="Berezino">
                <pos x="12928.000000" z="9906.000000" />
                <pos x="12900.000000" z="9900.000000" />
            </group>
            <group name="Chernogorsk">
                <pos x="6542.000000" z="2354.000000" />
            </group>
        </generator_posbubbles>
    </fresh>
    <hop>
        <generator_posbubbles>
            <group name="Balota">
                <pos x="1.000000" z="1.000000" />
            </group>
        </generator_posbubbles>
    </hop>
</playerspawnpoints>
`;

describe("narrowFreshSpawns", () => {
  it("keeps only the chosen <fresh> group; every other byte is untouched", () => {
    expect(narrowFreshSpawns(SPAWNS, "Berezino")).toBe(`<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<playerspawnpoints>
    <fresh>
        <spawn_params>
            <min_dist_player>65</min_dist_player>
        </spawn_params>
        <generator_posbubbles>
            <!-- <group name="Berezino"><pos x="1.000000" z="1.000000" /></group> -->
            <group name="Berezino">
                <pos x="12928.000000" z="9906.000000" />
                <pos x="12900.000000" z="9900.000000" />
            </group>
        </generator_posbubbles>
    </fresh>
    <hop>
        <generator_posbubbles>
            <group name="Balota">
                <pos x="1.000000" z="1.000000" />
            </group>
        </generator_posbubbles>
    </hop>
</playerspawnpoints>
`);
  });
  // ⚠️ Review focus 1: <hop> reuses town names; only <fresh> is narrowed.
  it("leaves a same-named group outside <fresh> alone", () => {
    expect(narrowFreshSpawns(SPAWNS, "Chernogorsk")).toContain(`<hop>
        <generator_posbubbles>
            <group name="Balota">`);
  });
  // ⚠️ Review focus 2: a commented-out copy is neither the group nor a duplicate of it.
  it("ignores a commented-out group", () => {
    expect(() => narrowFreshSpawns(SPAWNS, "Berezino")).not.toThrow();
    const onlyComment = SPAWNS.replace(/            <group name="Berezino">[\s\S]*?<\/group>\n/, "");
    expect(() => narrowFreshSpawns(onlyComment, "Berezino")).toThrow(/no group "Berezino"/);
  });
  // A self-closing group once ran the match on into the next group's </group>, so
  // narrowing to it kept that neighbour's spots too: players spread over two towns.
  it("treats a self-closing group as one empty group, never swallowing the next", () => {
    const selfClosing = SPAWNS.replace('<group name="Balota">\n                <pos x="4491.000000" z="2312.000000" />\n            </group>', '<group name="Balota" />');
    const out = narrowFreshSpawns(selfClosing, "Berezino");
    expect(out).not.toContain('<group name="Balota" />');
    expect(out).toContain('<group name="Berezino">');
    expect(() => narrowFreshSpawns(selfClosing, "Balota")).toThrow(/has no <pos>/);
  });
  it("refuses an unknown group, a duplicate, an empty group, and a file with no <fresh>", () => {
    expect(() => narrowFreshSpawns(SPAWNS, "Narnia")).toThrow(/^cfgplayerspawnpoints\.xml: .*no group "Narnia"/);
    const twice = SPAWNS.replace(`<group name="Chernogorsk">`, `<group name="Balota">`);
    expect(() => narrowFreshSpawns(twice, "Balota")).toThrow(/more than once/);
    const empty = SPAWNS.replace(`                <pos x="6542.000000" z="2354.000000" />\n`, "");
    expect(() => narrowFreshSpawns(empty, "Chernogorsk")).toThrow(/no <pos>/);
    expect(() => narrowFreshSpawns("<playerspawnpoints></playerspawnpoints>", "Balota")).toThrow(/no <fresh>/);
  });
});
