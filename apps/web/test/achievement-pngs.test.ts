import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ACHIEVEMENT_KEYS } from "@factions/domain";
import { lockedSvg, stripMetadata, renderPngs } from "../scripts/render-achievement-pngs";

const ART = join(import.meta.dirname, "..", "public", "achievements");

const SAMPLE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 64 64"><metadata>BIG</metadata>' +
  '<path d="M32 4z" fill="rgba(212,98,58,0.12)" stroke="#d4623a" stroke-width="2"></path>' +
  '<g transform="translate(17 15) scale(1.25)"><path d="M4 4" fill="none" stroke="#d4623a" stroke-width="2"></path></g></svg>';

describe("lockedSvg", () => {
  const out = lockedSvg(SAMPLE);
  it("outlines the shield in #2a2825 and draws the glyph in #4a4640", () => {
    expect(out).toMatch(/<path d="M32 4z"[^>]*stroke="#2a2825"/u);
    expect(out).toMatch(/<g [^>]*><path d="M4 4"[^>]*stroke="#4a4640"/u);
  });
  it("drops the group colour and the 12% tint", () => {
    expect(out).not.toContain("#d4623a");
    expect(out).not.toContain("rgba(");
    expect(out).toContain("#0b0b0a");
  });
  it("works for every group colour", () => {
    for (const hex of ["#e8e2d4", "#8fa36a", "#d9a03c"]) {
      expect(lockedSvg(SAMPLE.replaceAll("#d4623a", hex))).not.toContain(hex);
    }
  });
  it("stripMetadata removes the provenance block", () => {
    expect(stripMetadata(SAMPLE)).not.toContain("metadata");
  });
});

describe("renderPngs", () => {
  it("fills only missing files unless overwrite is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "ach-png-"));
    try {
      mkdirSync(join(root, "svg"));
      writeFileSync(join(root, "svg", "scratch.svg"), SAMPLE);
      const dirs = { root };
      expect(await renderPngs(["scratch"], { overwrite: false }, dirs)).toHaveLength(2);
      const file = join(root, "unlocked", "scratch.png");
      const first = statSync(file).mtimeMs;
      expect(await renderPngs(["scratch"], { overwrite: false }, dirs)).toEqual([]);
      expect(statSync(file).mtimeMs).toBe(first);
      expect(await renderPngs(["scratch"], { overwrite: true }, dirs)).toHaveLength(2);
      const meta = await sharp(file).metadata();
      expect([meta.width, meta.height]).toEqual([128, 128]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("committed badge art", () => {
  it.each(ACHIEVEMENT_KEYS.map((k) => [k]))("%s has an SVG and both PNGs", (key) => {
    for (const p of [`svg/${key}.svg`, `unlocked/${key}.png`, `locked/${key}.png`]) {
      expect(existsSync(join(ART, p)), `${p} missing: run pnpm --filter @factions/web achievements:png`).toBe(true);
    }
  });

  it("a locked PNG is drawn in the locked palette only", async () => {
    const { data } = await sharp(join(ART, "locked", `${ACHIEVEMENT_KEYS[0]}.png`)).raw().toBuffer({ resolveWithObject: true });
    const seen = new Set<string>();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 255) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    // Glyph colour is present, and no group colour (red-dominant) leaks in.
    expect(seen.has("74,70,64")).toBe(true);
    for (const rgb of seen) {
      const [r, g, b] = rgb.split(",").map(Number);
      expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!), rgb).toBeLessThan(16);
    }
  });
});
