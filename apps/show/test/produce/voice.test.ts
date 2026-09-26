import { describe, it, expect } from "vitest";
import path from "node:path";
import { voiceEpisode, type VoiceDeps } from "../../src/produce/voice.js";
import { ASSETS } from "../../src/assets.js";
import { MemoryPronunciationStore } from "../../src/engine/audio/pronunciationStore.js";
import { episodeCacheKey } from "../../src/engine/animation/episodeCache.js";
import type { ChatRequest } from "../../src/engine/llm/openrouter.js";
import type { Run } from "../../src/engine/run.js";
import { memFs, storyContext } from "./fakes.js";

const CACHE = "/cache";
const RHUBARB = "/bin/rhubarb";
const SR = 24000;

/** Non-silent s16le PCM (above trimSilencePcm's threshold) of `sec` seconds. */
function tone(sec: number): Buffer {
  const b = Buffer.alloc(Math.round(sec * SR) * 2);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(1000, i);
  return b;
}

const CONTEXT = storyContext({
  players: {
    topKillers: [
      { gamertag: "Xx5n1perXx", clan: null, value: 9 },
      { gamertag: "REDACTED_PLAYER_1", clan: null, value: 4 },
    ],
    mostDeaths: [],
    longestShots: [],
    oddDeaths: [],
  },
  clans: [
    {
      name: "REDACTED_CLAN_1", tag: "REDACTED_CLAN_1", status: "active", isStaff: false, pitch: null, members: 3,
      weekPoints: 10, weekRaids: 1, timesRaidedThisWeek: 0, seasonPoints: 10, seasonRaids: 1, flagDown: false,
    },
  ],
});

const NARRATIVE = [
  "Boris: Xx5n1perXx had nine kills this week.",
  "Pavel: And REDACTED_PLAYER_1 had four, for REDACTED_CLAN_1.",
].join("\n");

function harness() {
  const fsImpl = memFs({ [ASSETS.introMp3]: Buffer.from([1, 2, 3]), [ASSETS.outroMp3]: Buffer.from([4, 5, 6]) });
  const fetchBodies: string[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    fetchBodies.push(init.body);
    const pcm = tone(0.2);
    return { ok: true, arrayBuffer: async () => pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length) };
  }) as unknown as typeof fetch;
  const runs: { cmd: string; args: string[] }[] = [];
  const runImpl: Run = async (cmd, args) => {
    runs.push({ cmd, args });
    if (cmd === RHUBARB) return Buffer.from(JSON.stringify({ mouthCues: [{ start: 0, end: 0.1, value: "A" }] }));
    if (args.includes("mp3")) return Buffer.from("MP3DATA");
    return tone(0.5); // decodeClipPcm (jingles) and the per-turn wav conversion
  };
  const chats: ChatRequest[] = [];
  const chat = async (req: ChatRequest) => {
    chats.push(req);
    return JSON.stringify({ Xx5n1perXx: "sniper" });
  };
  const deps: VoiceDeps = {
    chat,
    pronunciationModel: "pm",
    store: new MemoryPronunciationStore(),
    overrides: {},
    elevenApiKey: "k",
    elevenModel: "eleven_multilingual_v2",
    borisVoiceId: "BORIS",
    pavelVoiceId: "PAVEL",
    cacheDir: CACHE,
    rhubarbPath: RHUBARB,
    runImpl,
    fetchImpl,
    fsImpl,
  };
  return { deps, fsImpl, fetchBodies, runs, chats };
}

describe("voiceEpisode", () => {
  it("voices the script, lip-syncs it, and writes the cached episode", async () => {
    const h = harness();
    const ep = await voiceEpisode(h.deps, { weekStart: "2026-09-21", narrative: NARRATIVE, context: CONTEXT });

    const key = episodeCacheKey({ weekStart: "2026-09-21", narrative: NARRATIVE });
    expect(ep.key).toBe(key);
    expect(ep.mp3Path).toBe(path.join(CACHE, key, "episode.mp3"));
    expect(h.fsImpl.files.get(ep.mp3Path)?.toString()).toBe("MP3DATA");

    // Two turns synthesized, one per voice, and lip-synced with the configured rhubarb.
    expect(h.fetchBodies).toHaveLength(2);
    expect(h.runs.filter((r) => r.cmd === RHUBARB)).toHaveLength(2);
    expect(ep.timeline.map((t) => t.speaker)).toEqual(["boris", "pavel"]);
    expect(ep.timeline[0]!.visemes[0]).toEqual({ startSec: ep.timeline[0]!.startSec, endSec: ep.timeline[0]!.startSec + 0.1, mouth: "Lip_A" });

    // Spans are ClipSpan {startSec, durSec}; the outro follows the dialogue, the total covers all.
    expect(ep.segASpan.durSec).toBeGreaterThan(0);
    expect(ep.outroSpan.startSec).toBeGreaterThan(ep.segASpan.startSec);
    expect(ep.outroSpan.startSec + ep.outroSpan.durSec).toBeCloseTo(ep.totalSec, 6);

    // Jingles cached under the cache dir, not next to the bundled asset.
    const jingleFiles = [...h.fsImpl.files.keys()].filter((k) => k.includes(".jingle-cache"));
    expect(jingleFiles.length).toBe(2);
    for (const f of jingleFiles) expect(f.startsWith(path.join(CACHE, ".jingle-cache") + path.sep)).toBe(true);
  });

  it("speaks redacted aliases per spec 7.3 and never sends REDACTED_ to ElevenLabs or the model", async () => {
    const h = harness();
    await voiceEpisode(h.deps, { weekStart: "2026-09-21", narrative: NARRATIVE, context: CONTEXT });
    const texts = h.fetchBodies.map((b) => (JSON.parse(b) as { text: string }).text);
    expect(texts[0]).toBe("sniper had nine kills this week.");
    expect(texts[1]).toBe("And the player whose name we cannot say had four, for a clan we can't name on this network.");
    for (const b of h.fetchBodies) expect(b).not.toContain("REDACTED_");
    expect(h.chats.length).toBe(1);
    for (const c of h.chats) expect(JSON.stringify(c)).not.toContain("REDACTED_");
  });

  it("an alias only in the narrative is still spoken, never read raw", async () => {
    const h = harness();
    const narrative = "Boris: REDACTED_PLAYER_7 showed up.\nPavel: Right.";
    await voiceEpisode(h.deps, { weekStart: "2026-09-21", narrative, context: storyContext() });
    for (const b of h.fetchBodies) expect(b).not.toContain("REDACTED_");
  });

  it("a second call with the same week and narrative makes zero fetch, run and chat calls", async () => {
    const h = harness();
    const first = await voiceEpisode(h.deps, { weekStart: "2026-09-21", narrative: NARRATIVE, context: CONTEXT });
    h.fetchBodies.length = 0;
    h.runs.length = 0;
    h.chats.length = 0;
    const second = await voiceEpisode(h.deps, { weekStart: "2026-09-21", narrative: NARRATIVE, context: CONTEXT });
    expect(h.fetchBodies).toHaveLength(0);
    expect(h.runs).toHaveLength(0);
    expect(h.chats).toHaveLength(0);
    expect(second).toEqual(first);
  });

  it("a changed narrative makes new calls", async () => {
    const h = harness();
    await voiceEpisode(h.deps, { weekStart: "2026-09-21", narrative: NARRATIVE, context: CONTEXT });
    h.fetchBodies.length = 0;
    h.runs.length = 0;
    const second = await voiceEpisode(h.deps, {
      weekStart: "2026-09-21",
      narrative: NARRATIVE + "\nBoris: One more line.",
      context: CONTEXT,
    });
    expect(h.fetchBodies).toHaveLength(3);
    expect(h.runs.length).toBeGreaterThan(0);
    expect(second.key).not.toBe(episodeCacheKey({ weekStart: "2026-09-21", narrative: NARRATIVE }));
  });

  it("throws when the narrative has no dialogue (nothing to animate)", async () => {
    const h = harness();
    await expect(
      voiceEpisode(h.deps, { weekStart: "2026-09-21", narrative: "no labels here", context: CONTEXT }),
    ).rejects.toThrow(/no dialogue/);
  });
});
