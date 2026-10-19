import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSpecialRender, specialCacheKeyWeek, type SpecialRenderIo } from "../../src/special/render-cli.js";

const REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../specials/2026-10-nasdara");

function fakeIo(screenReasons: string[]) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "special-render-"));
  const calls = { voice: [] as any[], render: [] as any[], screened: [] as string[] };
  const mp3 = path.join(work, "cached.mp3");
  const mp4 = path.join(work, "cached.mp4");
  fs.writeFileSync(mp3, "MP3");
  fs.writeFileSync(mp4, "MP4");
  const io: SpecialRenderIo = {
    preflight: async () => {},
    screen: async (t) => { calls.screened.push(t); return screenReasons; },
    voice: async (ep) => {
      calls.voice.push(ep);
      return { key: "k", mp3Path: mp3, totalSec: 140, segASpan: { startSec: 1, durSec: 2 }, outroSpan: { startSec: 3, durSec: 1 }, timeline: [] };
    },
    render: async (ep) => { calls.render.push(ep); return mp4; },
    log: () => {},
  };
  return { io, calls, out: path.join(work, "out") };
}

describe("runSpecialRender", () => {
  it("screen reasons hold the render", async () => {
    const f = fakeIo(["blocklist: x"]);
    expect(await runSpecialRender({ dir: REAL, out: f.out }, f.io)).toBe(1);
    expect(f.calls.voice).toHaveLength(0);
    expect(f.calls.render).toHaveLength(0);
  });

  it("renders and copies episode.mp3 and video.mp4 into out", async () => {
    const f = fakeIo([]);
    expect(await runSpecialRender({ dir: REAL, out: f.out }, f.io)).toBe(0);
    expect(fs.readFileSync(path.join(f.out, "episode.mp3"), "utf8")).toBe("MP3");
    expect(fs.readFileSync(path.join(f.out, "video.mp4"), "utf8")).toBe("MP4");
    expect(f.calls.screened[0]).toContain("Boris:");
    expect(f.calls.voice[0].weekStart).toBe(specialCacheKeyWeek("2026-10-nasdara"));
    expect(f.calls.voice[0].weekStart).toBe("special:2026-10-nasdara");
    expect(f.calls.voice[0].names.names).toContain("Bustanshahr");
    const sp = f.calls.render[0].special;
    expect(sp.introScreenPath).toBe(path.join(REAL, "intro.png"));
    expect(sp.outroStillPath).toBe(path.join(REAL, "outro.png"));
    expect(sp.cards.length).toBeGreaterThan(0);
    expect(sp.marqueeItems).toContain("dayzclanwars.com");
  });
});
