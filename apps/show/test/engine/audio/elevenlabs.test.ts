import { describe, it, expect } from "vitest";
import { elevenTurnPcm, synthesizeElevenPcm, synthesizeElevenPcmTimed } from "../../../src/engine/audio/elevenlabs.js";

const abOf = (bytes: number[]) => new Uint8Array(bytes).buffer;
// Two audible s16le samples (4096, 4096) — above trimSilencePcm's silence floor so they survive.
const LOUD = [0, 16, 0, 16];

function fakeFetch() {
  const calls: { url: string; opts: RequestInit & { headers: Record<string, string>; body: string } }[] = [];
  const fn = async (url: string | URL, opts: RequestInit & { headers: Record<string, string>; body: string }) => {
    calls.push({ url: String(url), opts });
    return { ok: true, status: 200, arrayBuffer: async () => abOf(LOUD) };
  };
  (fn as typeof fn & { calls: typeof calls }).calls = calls;
  return fn as unknown as typeof fetch & { calls: typeof calls };
}

describe("elevenTurnPcm", () => {
  it("POSTs the line to the voice endpoint as pcm_24000 and returns the raw pcm", async () => {
    const fetchImpl = fakeFetch();
    const pcm = await elevenTurnPcm({ text: "hi there", voiceId: "V1", apiKey: "k", modelId: "eleven_multilingual_v2", fetchImpl });
    const call = fetchImpl.calls[0]!;
    expect(call.url).toContain("/text-to-speech/V1");
    expect(call.url).toContain("output_format=pcm_24000");
    expect(call.opts.headers["xi-api-key"]).toBe("k");
    const body = JSON.parse(call.opts.body);
    expect(body.text).toBe("hi there"); // ONLY the line — no delivery-direction prefix
    expect(body.model_id).toBe("eleven_multilingual_v2");
    expect([...pcm]).toEqual(LOUD);
  });

  it("throws on a non-2xx", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 401, text: async () => "bad key" })) as unknown as typeof fetch;
    await expect(elevenTurnPcm({ text: "x", voiceId: "V", apiKey: "k", modelId: "m", fetchImpl })).rejects.toThrow(/401/);
  });
});

describe("synthesizeElevenPcm", () => {
  it("synthesizes each turn with its own voice, concatenated", async () => {
    const fetchImpl = fakeFetch();
    const inputs = [
      { text: "a", voice_id: "V1" },
      { text: "b", voice_id: "V2" },
    ];
    const pcm = await synthesizeElevenPcm({ inputs, apiKey: "k", modelId: "m", fetchImpl });
    expect(fetchImpl.calls).toHaveLength(2);
    expect(fetchImpl.calls[0]!.url).toContain("/text-to-speech/V1");
    expect(fetchImpl.calls[1]!.url).toContain("/text-to-speech/V2");
    expect(JSON.parse(fetchImpl.calls[0]!.opts.body).text).toBe("a"); // line only
    expect(pcm.length).toBeGreaterThan(0);
  });
});

describe("synthesizeElevenPcmTimed", () => {
  // 24000 Hz * 2 bytes: 0.5s = 24000 bytes. NON-SILENT fill (0x20 => sample 0x2020) so trimSilencePcm
  // keeps it — an all-zero Buffer.alloc would be trimmed to empty and both turns would vanish.
  const bytesFor = (n: number) => Buffer.alloc(n, 0x20);
  function fakeTimedFetch(map: Record<string, Buffer>) {
    return (async (_url: string, opts: RequestInit & { body: string }) => {
      const { text } = JSON.parse(opts.body);
      return { ok: true, arrayBuffer: async () => map[text] ?? bytesFor(24000) };
    }) as unknown as typeof fetch;
  }

  it("records per-turn spans (excluding gaps) and voice ids", async () => {
    const inputs = [
      { text: "a", voice_id: "boris" },
      { text: "b", voice_id: "pavel" },
    ];
    // 24000 bytes = 0.5s each (no leading/trailing silence to trim).
    const { pcm, turns } = await synthesizeElevenPcmTimed({
      inputs,
      apiKey: "k",
      fetchImpl: fakeTimedFetch({ a: bytesFor(24000), b: bytesFor(24000) }),
    });
    expect(turns).toHaveLength(2);
    expect(turns[0]!).toEqual({ startSec: 0, endSec: 0.5, voiceId: "boris" });
    // second turn starts after turn0 audio (0.5s) + one GAP (~0.1s).
    expect(turns[1]!.voiceId).toBe("pavel");
    expect(turns[1]!.startSec).toBeCloseTo(0.6, 3);
    expect(turns[1]!.endSec).toBeCloseTo(1.1, 3);
    expect(pcm.length).toBeGreaterThan(0);
  });
});
