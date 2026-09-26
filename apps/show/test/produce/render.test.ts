import { describe, it, expect } from "vitest";
import path from "node:path";
import { renderEpisode, type RenderDeps } from "../../src/produce/render.js";
import type { VoicedEpisode } from "../../src/produce/voice.js";
import { ASSETS } from "../../src/assets.js";
import type { Run } from "../../src/engine/run.js";
import { memFs, storyContext } from "./fakes.js";

const CACHE = "/cache";
const ASSET_DIR = path.dirname(ASSETS.introMp3);

const VOICED: VoicedEpisode = {
  key: "2026-09-21-abc123",
  mp3Path: "/cache/2026-09-21-abc123/episode.mp3",
  totalSec: 4,
  segASpan: { startSec: 0.5, durSec: 2 },
  outroSpan: { startSec: 3, durSec: 1 },
  timeline: [
    { speaker: "boris", startSec: 0, endSec: 1, visemes: [{ startSec: 0, endSec: 0.5, mouth: "Lip_A" }] },
    { speaker: "pavel", startSec: 1.1, endSec: 2, visemes: [{ startSec: 1.1, endSec: 1.5, mouth: "Lip_B" }] },
  ],
};

const CONTEXT = storyContext({
  players: {
    topKillers: [{ gamertag: "killer<&>", clan: null, value: 9 }],
    mostDeaths: [],
    longestShots: [],
    oddDeaths: [],
  },
});

function harness() {
  const fsImpl = memFs({}, (p) => p.startsWith(ASSET_DIR));
  const svgs: string[] = [];
  const ResvgImpl = class {
    constructor(svg: string) {
      svgs.push(svg);
    }
    render() {
      return { asPng: () => Buffer.from([1]) };
    }
  };
  const runs: string[][] = [];
  const runImpl: Run = async (_cmd, args) => {
    runs.push(args);
    // Every ffmpeg call here writes its output file as the last argument.
    fsImpl.writeFileSync(args[args.length - 1]!, Buffer.from("VIDEO"));
    return Buffer.alloc(0);
  };
  const deps: RenderDeps = { cacheDir: CACHE, discordInvite: "discord.gg/TJu4XP25nr", runImpl, ResvgImpl, fsImpl };
  return { deps, fsImpl, svgs, runs };
}

describe("renderEpisode", () => {
  it("renders the animated episode once and caches video.mp4 under the key", async () => {
    const h = harness();
    const out = await renderEpisode(h.deps, { voiced: VOICED, context: CONTEXT });
    expect(out).toBe(path.join(CACHE, VOICED.key, "video.mp4"));
    expect(h.fsImpl.files.get(out)?.toString()).toBe("VIDEO");

    // The final stitch runs exactly once, over the voiced mp3, and writes a work-dir mp4 that is then cached.
    const stitches = h.runs.filter((a) => a.includes("aac"));
    expect(stitches).toHaveLength(1);
    expect(stitches[0]).toContain(VOICED.mp3Path);
    expect(stitches[0]).toContain(ASSETS.introScreen);
    // Rig back layer composite, screen clip, segment, stitch: four ffmpeg calls in all.
    expect(h.runs).toHaveLength(4);

    // Work dir cleaned up.
    expect([...h.fsImpl.files.keys()].filter((k) => k.includes("show-anim-"))).toEqual([]);
  });

  it("builds the cards and marquee from the context", async () => {
    const h = harness();
    await renderEpisode(h.deps, { voiced: VOICED, context: CONTEXT });
    const all = h.svgs.join("\n");
    expect(all).toContain("CLAN WARS · S01E03");
    expect(all).toContain("DAYZCLANWARS.COM");
    expect(all).toContain("discord.gg/TJu4XP25nr");
    expect(all).not.toContain("DISCORD.GG");
    expect(all).toContain("killer&lt;&amp;&gt;");
    expect(all).not.toContain("killer<&>");
    // The outro board headline.
    expect(all).toContain("AFTER WEEK 3");
  });

  it("a second call with the same key makes zero runner calls", async () => {
    const h = harness();
    const first = await renderEpisode(h.deps, { voiced: VOICED, context: CONTEXT });
    h.runs.length = 0;
    h.svgs.length = 0;
    const second = await renderEpisode(h.deps, { voiced: VOICED, context: CONTEXT });
    expect(second).toBe(first);
    expect(h.runs).toHaveLength(0);
    expect(h.svgs).toHaveLength(0);
  });

  it("a different key renders again", async () => {
    const h = harness();
    await renderEpisode(h.deps, { voiced: VOICED, context: CONTEXT });
    h.runs.length = 0;
    await renderEpisode(h.deps, { voiced: { ...VOICED, key: "2026-09-21-def456" }, context: CONTEXT });
    expect(h.runs.filter((a) => a.includes("aac"))).toHaveLength(1);
  });
});
