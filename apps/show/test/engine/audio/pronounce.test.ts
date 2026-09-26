import { describe, test, expect } from "vitest";
import type { ChatFn } from "../../../src/engine/llm/openrouter.js";
import { pronounceGamertags, resolvePronouncer } from "../../../src/engine/audio/pronounce.js";

function jsonChat(map: Record<string, string>): ChatFn & { calls: { model: string; messages: { role: string; content: string }[] }[] } {
  const calls: { model: string; messages: { role: string; content: string }[] }[] = [];
  const fn = (async (req) => {
    calls.push(req as never);
    return JSON.stringify(map);
  }) as ChatFn & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

// Returns the content verbatim (used to model providers that wrap JSON in markdown fences).
function rawContentChat(content: string): ChatFn {
  return async () => content;
}

describe("pronounceGamertags", () => {
  test("returns the spoken map and sends the tags", async () => {
    const chat = jsonChat({ XxBE4zyxX: "Beezy", Sn1p3r: "Sniper" });
    const out = await pronounceGamertags(["XxBE4zyxX", "Sn1p3r"], { chat, model: "m" });
    expect(out).toEqual({ XxBE4zyxX: "Beezy", Sn1p3r: "Sniper" });
    expect(chat.calls[0]!.messages[1]!.content).toContain("XxBE4zyxX");
  });

  test("empty input makes no call", async () => {
    const chat = jsonChat({});
    expect(await pronounceGamertags([], { chat, model: "m" })).toEqual({});
    expect(chat.calls).toHaveLength(0);
  });

  test("parses a JSON object wrapped in a ```json markdown fence (Anthropic via OpenRouter)", async () => {
    const fenced = '```json\n{ "Sn1p3r": "Sniper", "XxBE4zyxX": "Beezy" }\n```';
    const out = await pronounceGamertags(["Sn1p3r", "XxBE4zyxX"], { chat: rawContentChat(fenced), model: "m" });
    expect(out).toEqual({ Sn1p3r: "Sniper", XxBE4zyxX: "Beezy" });
  });

  test("parses a bare ``` fence and tolerates surrounding prose", async () => {
    const out = await pronounceGamertags(["Sn1p3r"], {
      chat: rawContentChat('Here you go:\n```\n{ "Sn1p3r": "Sniper" }\n```'),
      model: "m",
    });
    expect(out).toEqual({ Sn1p3r: "Sniper" });
  });

  test("throws when chat throws", async () => {
    const chat: ChatFn = async () => {
      throw new Error("500");
    };
    await expect(pronounceGamertags(["a"], { chat, model: "m" })).rejects.toThrow(/500/);
  });

  test("system prompt states the rules and the hybrid natural/phonetic choice", async () => {
    const chat = jsonChat({ a: "a" });
    await pronounceGamertags(["a"], { chat, model: "m" });
    const sys = chat.calls[0]!.messages[0]!.content.toLowerCase();
    expect(sys).toContain("leet"); // de-leet rule present
    expect(sys).toContain("trailing"); // drop trailing digits rule present
    expect(sys).toContain("phonetic"); // hybrid phonetic option present
    expect(chat.calls[0]!.model).toBe("m"); // passed model is used
  });
});

describe("resolvePronouncer", () => {
  test("prefers override, then llmMap, then speakableName", () => {
    const p = resolvePronouncer({ overrides: { XxBE4zyxX: "Beezy" }, llmMap: { Sn1p3r: "Sniper" } });
    expect(p("XxBE4zyxX")).toBe("Beezy"); // override wins
    expect(p("Sn1p3r")).toBe("Sniper"); // llm fills
    expect(p("DarkSniper4729")).toBe("DarkSniper"); // speakableName fallback
  });
});
